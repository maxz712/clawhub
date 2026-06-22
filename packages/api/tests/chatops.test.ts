import { describe, it, expect } from "vitest";
import { handleSlashCommand } from "../src/services/chatops.js";
import { agents, changes, repositories } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

const UUID = "11111111-1111-1111-1111-111111111111";

// Batch 8: the /clawhub approve command was a no-op that PRETENDED to approve
// (governance theater) — removed. /clawhub change is a real lookup but a Slack
// request isn't an authenticated user, so it must ONLY surface PUBLIC repos.
function makeDb(change: Record<string, unknown> | null, repo: Record<string, unknown> | null): DB {
  const db = {
    select: (_c?: unknown) => ({ from: (t: unknown) => {
      const rows = t === changes ? (change ? [change] : [])
        : t === repositories ? (repo ? [repo] : [])
        : t === agents ? [{ id: "ag1", name: "alice" }]
        : [];
      const chain = { where: () => chain, limit: (n: number) => Promise.resolve(rows.slice(0, n)), then: (r: (v: unknown[]) => void) => r(rows) };
      return chain as typeof chain & PromiseLike<unknown[]>;
    } }),
  };
  return db as unknown as DB;
}
const cmd = (text: string) => ({ command: "/clawhub", text, user_id: "u", user_name: "u", channel_id: "c" });

describe("chatops handleSlashCommand", () => {
  it("status is honest", async () => {
    const r = await handleSlashCommand(makeDb(null, null), cmd("status"));
    expect(r.text.toLowerCase()).toContain("up");
  });

  it("the removed /clawhub approve no longer pretends to approve", async () => {
    const r = await handleSlashCommand(makeDb(null, null), cmd("approve some-change"));
    expect(r.text.toLowerCase()).not.toContain("approval request");
    expect(r.text.toLowerCase()).not.toMatch(/approved|will approve/);
    expect(r.text).toMatch(/dashboard/i); // points to where approval actually happens
  });

  it("change <non-uuid> returns usage (never hits the uuid query)", async () => {
    const r = await handleSlashCommand(makeDb(null, null), cmd("change not-a-uuid"));
    expect(r.text).toMatch(/Usage/i);
  });

  it("change in a PRIVATE repo is NOT surfaced (no leak)", async () => {
    const change = { id: UUID, repoId: "r1", intent: "secret work", status: "pending", risk: "low", computedRisk: null };
    const repo = { id: "r1", isPublic: false, namespaceType: "agent", namespaceId: "ag1", name: "demo" };
    const r = await handleSlashCommand(makeDb(change, repo), cmd(`change ${UUID}`));
    expect(r.text).not.toContain("secret work");
    expect(r.text.toLowerCase()).toContain("private");
  });

  it("change in a PUBLIC repo returns intent + status + a link", async () => {
    const change = { id: UUID, repoId: "r1", intent: "ship the thing", status: "approved", risk: "low", computedRisk: "medium" };
    const repo = { id: "r1", isPublic: true, namespaceType: "agent", namespaceId: "ag1", name: "demo" };
    const r = await handleSlashCommand(makeDb(change, repo), cmd(`change ${UUID}`));
    expect(r.text).toContain("ship the thing");
    expect(r.text).toContain("approved");
    expect(r.text).toContain("/r/alice/demo/changes/");
  });
});
