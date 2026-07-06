import { describe, expect, it } from "vitest";
import { parseSlashCommand, slashCommandsEnabled } from "../src/services/slash-commands.js";
import { agentRunGroup, collapseStalePending, hasLiveRunForVersion } from "../src/services/run-leases.js";
import { hasTestDb, testDb } from "./test-db.js";
import { ciRuns, repositories, users } from "../src/models/schema.js";
import { eq } from "drizzle-orm";

// v3 P4 (docs/redesign-v3.md §4): thread slash commands + coalesce leases.

describe("parseSlashCommand (pure)", () => {
  it("parses a leading command with operator focus", () => {
    const p = parseSlashCommand("/review focus on the auth changes");
    expect(p?.command).toBe("/review");
    expect(p?.workflow.mode).toBe("review");
    expect(p?.task).toBe("/review focus on the auth changes");
  });

  it("maps aliases (/test → /verify)", () => {
    const p = parseSlashCommand("/test");
    expect(p?.command).toBe("/verify");
    expect(p?.workflow.mode).toBe("verify");
  });

  it("only a LEADING command triggers — mid-text mentions are just text", () => {
    expect(parseSlashCommand("please run /review on this")).toBeNull();
    expect(parseSlashCommand("  \n/review late start")).not.toBeNull(); // leading after whitespace is fine
  });

  it("unknown commands pass through as plain comments", () => {
    expect(parseSlashCommand("/frobnicate now")).toBeNull();
  });

  it("focus is bounded to the first line (bounded prompt surface)", () => {
    const p = parseSlashCommand("/dev fix the header\nignore this second line\nand this");
    expect(p?.task).toBe("/dev fix the header");
  });

  it("kill switch reads env", () => {
    const prev = process.env.CLAWHUB_DISABLE_SLASH_COMMANDS;
    process.env.CLAWHUB_DISABLE_SLASH_COMMANDS = "1";
    expect(slashCommandsEnabled()).toBe(false);
    if (prev === undefined) delete process.env.CLAWHUB_DISABLE_SLASH_COMMANDS;
    else process.env.CLAWHUB_DISABLE_SLASH_COMMANDS = prev;
    expect(slashCommandsEnabled()).toBe(true);
  });
});

describe("agentRunGroup", () => {
  it("keys identity:mode:resource", () => {
    expect(agentRunGroup({ id: "A", mode: "verify" }, "C1")).toBe("agent:A:verify:C1");
    expect(agentRunGroup({ id: "A", mode: null }, null)).toBe("agent:A:worker:repo");
  });
});

describe.skipIf(!hasTestDb)("coalesce-to-latest leases (db)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  async function mkRepo() {
    const [u] = await testDb.insert(users).values({ email: `${uniq()}@t.local`, username: `u-${uniq()}`, passwordHash: "x" }).returning();
    return (await testDb.insert(repositories).values({ name: `r-${uniq()}`, namespaceType: "user", namespaceId: u.id }).returning())[0];
  }

  it("same-(group, commit) live run dedupes; stale pending collapses on a newer version", async () => {
    const repo = await mkRepo();
    const group = `agent:${uniq()}:verify:change-1`;
    // A pending run for OLD head.
    const [oldRun] = await testDb.insert(ciRuns).values({
      repoId: repo.id, runnerToken: uniq(), origin: "agent", commit: "old-sha", status: "pending", concurrencyGroup: group,
    }).returning();

    // Same version → duplicate detected.
    expect(await hasLiveRunForVersion(testDb, group, "old-sha")).toBe(true);
    // New version → not a duplicate; the stale pending collapses.
    expect(await hasLiveRunForVersion(testDb, group, "new-sha")).toBe(false);
    const collapsed = await collapseStalePending(testDb, group, "new-sha");
    expect(collapsed).toBe(1);
    const after = (await testDb.select().from(ciRuns).where(eq(ciRuns.id, oldRun.id)))[0];
    expect(after.status).toBe("skipped");
    expect(after.terminalReason).toBe("superseded");
  });

  it("running runs are left to finish (only pending collapses)", async () => {
    const repo = await mkRepo();
    const group = `agent:${uniq()}:verify:change-2`;
    const [running] = await testDb.insert(ciRuns).values({
      repoId: repo.id, runnerToken: uniq(), origin: "agent", commit: "old-sha", status: "running", concurrencyGroup: group,
    }).returning();
    expect(await collapseStalePending(testDb, group, "new-sha")).toBe(0);
    const after = (await testDb.select().from(ciRuns).where(eq(ciRuns.id, running.id)))[0];
    expect(after.status).toBe("running");
  });
});
