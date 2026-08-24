import { describe, it, expect, beforeAll } from "vitest";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, changes, ciRuns, repositories, standingAgents, users, verificationRuns } from "../src/models/schema.js";
import { reconcileUnverifiedChanges } from "../src/services/standing-agent-scheduler.js";
import type { EventBus } from "../src/services/events.js";
import { eq } from "drizzle-orm";

// Issue #209 — reconcileUnverifiedChanges' only per-change exit condition was a
// head-pinned SUCCESS attestation, which is structurally unreachable for a
// change whose verification legitimately failed, for review-mode reviewers
// (they submit reviews, never attestations), and for static-tier changes. With
// no attempt counter and no per-commit dedup, one stranded Change re-dispatched
// a full container+LLM reviewer run every ~10 minutes for 24 hours (124
// identical reviews on one commit in production).
//
// The fix: a COMPLETED reviewer run against the EXACT current head inside
// RECONCILE_RETRY_MS suppresses further re-pokes of that head. A re-push moves
// the head and reconciles immediately; an old terminal run outside the window
// still retries (environmental-flake recovery); `skipped` runs don't count.

const S = Date.now();
const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);

function bus(): { events: EventBus; pokes: string[] } {
  const pokes: string[] = [];
  const events = {
    publish: async (e: { changeId?: string }) => { if (e.changeId) pokes.push(e.changeId); },
  } as unknown as EventBus;
  return { events, pokes };
}

describe.skipIf(!hasTestDb)("reconcile retry window (#209)", () => {
  let repoId = "";
  let saId = "";

  beforeAll(async () => {
    const [owner] = await db.insert(users).values({
      email: `r209-${S}@t.local`, username: `r209-owner-${S}`, passwordHash: "x",
    }).returning();
    const [repo] = await db.insert(repositories).values({
      name: `r209repo${S}`, namespaceType: "user", namespaceId: owner.id,
      defaultBranch: "main", isPublic: false,
    }).returning();
    repoId = repo.id;
    const [reviewer] = await db.insert(agents).values({
      name: `r209-reviewer-${S}`, tokenHash: "x",
      gitAuthorName: "r", gitAuthorEmail: "r@t.local",
    }).returning();
    const [sa] = await db.insert(standingAgents).values({
      repoId: repo.id, agentId: reviewer.id, name: `r209-verify-${S}`,
      image: "img", tokenCiphertext: "c", tokenNonce: "n",
      mode: "verify", trigger: "event", enabled: true,
    }).returning();
    saId = sa.id;
  });

  async function mkChange(tag: string): Promise<string> {
    const [ch] = await db.insert(changes).values({
      repoId, branch: `r209/${tag}-${S}`, headCommit: HEAD, intent: `t-${tag}`,
      status: "pending", ciStatus: "success", isDraft: false,
    }).returning();
    return ch.id;
  }

  async function mkRun(changeId: string, opts: { commit: string; status: string; ageMs: number }): Promise<string> {
    const [run] = await db.insert(ciRuns).values({
      repoId, changeId, standingAgentId: saId, origin: "agent",
      commit: opts.commit, status: opts.status, runnerToken: `rt-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date(Date.now() - opts.ageMs),
    }).returning();
    return run.id;
  }

  it("pokes a green, unlooked-at change (baseline reconcile behavior)", async () => {
    const chId = await mkChange("bare");
    const { events, pokes } = bus();
    await reconcileUnverifiedChanges(db, events);
    expect(pokes).toContain(chId);
    await db.delete(changes).where(eq(changes.id, chId));
  });

  it("does NOT re-poke a head a reviewer run already completed on inside the retry window", async () => {
    const chId = await mkChange("looked");
    // 30 min old: past the 10-min dispatch throttle (which suppressed pre-fix
    // pokes only briefly), well inside the 6h retry window.
    await mkRun(chId, { commit: HEAD, status: "failure", ageMs: 30 * 60_000 });
    const { events, pokes } = bus();
    await reconcileUnverifiedChanges(db, events);
    expect(pokes).not.toContain(chId);
    await db.delete(changes).where(eq(changes.id, chId));
  });

  it("retries once the terminal run ages out of the retry window", async () => {
    const chId = await mkChange("aged");
    await mkRun(chId, { commit: HEAD, status: "failure", ageMs: 7 * 3600_000 });
    const { events, pokes } = bus();
    await reconcileUnverifiedChanges(db, events);
    expect(pokes).toContain(chId);
    await db.delete(changes).where(eq(changes.id, chId));
  });

  it("re-pokes immediately after a push moves the head (old-head run doesn't count)", async () => {
    const chId = await mkChange("repush");
    await mkRun(chId, { commit: OLD_HEAD, status: "failure", ageMs: 30 * 60_000 });
    const { events, pokes } = bus();
    await reconcileUnverifiedChanges(db, events);
    expect(pokes).toContain(chId);
    await db.delete(changes).where(eq(changes.id, chId));
  });

  it("a skipped (coalesced) run does not count as having looked", async () => {
    const chId = await mkChange("skipped");
    await mkRun(chId, { commit: HEAD, status: "skipped", ageMs: 30 * 60_000 });
    const { events, pokes } = bus();
    await reconcileUnverifiedChanges(db, events);
    expect(pokes).toContain(chId);
    await db.delete(changes).where(eq(changes.id, chId));
  });

  it("a head-pinned SUCCESS attestation still skips permanently (existing exit unchanged)", async () => {
    const chId = await mkChange("attested");
    const runId = await mkRun(chId, { commit: HEAD, status: "success", ageMs: 8 * 3600_000 });
    const [reviewer] = await db.select({ agentId: standingAgents.agentId }).from(standingAgents).where(eq(standingAgents.id, saId));
    await db.insert(verificationRuns).values({
      repoId, changeId: chId, ciRunId: runId, standingAgentId: saId,
      agentId: reviewer.agentId, headCommit: HEAD, status: "success",
      checks: [], passedCount: 1, failedCount: 0, reportedAt: new Date(),
    });
    const { events, pokes } = bus();
    await reconcileUnverifiedChanges(db, events);
    expect(pokes).not.toContain(chId);
    await db.delete(changes).where(eq(changes.id, chId));
  });
});
