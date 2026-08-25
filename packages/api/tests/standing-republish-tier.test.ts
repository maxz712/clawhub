import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, branches, changes, ciRuns, repositories, standingAgents, users } from "../src/models/schema.js";
import { dispatchStandingRun, republishStalePendingStandingRuns } from "../src/services/standing-agents.js";
import type { EventBus } from "../src/services/events.js";

// #172 — republishStalePendingStandingRuns called queuedPayload WITHOUT the
// change's server-derived verify tier, and the legacy fallback resolved the
// ambiguity toward MORE privilege: every re-delivered verify run (the normal
// case after a deploy restarts the runner) was stamped `dind:true` and booted
// --privileged with cap-drop=ALL skipped — for a run the server had classified
// `static`. The republished payload must be IDENTICAL in tier to the original,
// asserted here on the PUBLISHED event payload (the pure selectVerifyTier tests
// are exactly why this wiring gap was invisible to CI).

const S = Date.now();
type Payload = { runId: string; verifyTier?: string; dind?: boolean };

describe.skipIf(!hasTestDb)("standing verify runs keep their tier on re-delivery (#172)", () => {
  let repoId: string;
  let agentId: string;
  const published: Payload[] = [];
  const events = { publish: async (e: { payload?: unknown }) => { published.push(e.payload as Payload); } } as unknown as EventBus;
  const HEAD = "a".repeat(40);
  const madeSaIds: string[] = [];

  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `rt-${S}@t.co`, username: `rtu${S}`, passwordHash: "x" }).returning();
    const [r] = await db.insert(repositories).values({ name: `rtrepo${S}`, namespaceType: "user", namespaceId: u.id, defaultBranch: "main" }).returning();
    repoId = r.id;
    await db.insert(branches).values({ repoId, name: "main", headCommit: HEAD });
    const [a] = await db.insert(agents).values({ name: `rt-agent-${S}`, tokenHash: "x", gitAuthorName: "rt-bot", gitAuthorEmail: "rt-bot@clawhub.test" }).returning();
    agentId = a.id;
  });

  afterAll(async () => {
    // FK cascades from repositories/agents clean the rest.
    await db.delete(repositories).where(eq(repositories.id, repoId));
    await db.delete(agents).where(eq(agents.id, agentId));
  });

  async function makeVerifyAgent(mode = "verify") {
    const [sa] = await db.insert(standingAgents).values({
      repoId, agentId, name: `rt-sa-${mode}-${madeSaIds.length}-${S}`, image: "ghcr.io/x/harness:latest",
      mode, trigger: "manual", tokenCiphertext: "sealed", tokenNonce: "n",
    }).returning();
    madeSaIds.push(sa.id);
    return sa;
  }

  async function makeChange(verifyTier: string | null, branch: string) {
    const [chg] = await db.insert(changes).values({
      repoId, branch, headCommit: HEAD, intent: "t", risk: "low", verifyTier,
    }).returning();
    return chg;
  }

  /** Dispatch, capture the original payload, then republish past the cutoff and capture the second. */
  async function bothDeliveries(sa: Awaited<ReturnType<typeof makeVerifyAgent>>, changeId?: string): Promise<{ first: Payload; second: Payload }> {
    published.length = 0;
    const res = await dispatchStandingRun(db, events, sa, { manual: true, ...(changeId ? { changeId, commit: HEAD } : {}) });
    expect(res.ok, `dispatch failed: ${JSON.stringify(res)}`).toBe(true);
    const first = published.find(p => p.runId === (res as { runId: string }).runId)!;
    expect(first).toBeTruthy();
    published.length = 0;
    // Republish everything still pending, evaluated as if the window elapsed. The
    // big limit keeps this deterministic when other suites (or prior runs) left
    // their own pending standing runs in the shared test database.
    await republishStalePendingStandingRuns(db, events, new Date(Date.now() + 10 * 60_000), 10_000);
    const second = published.find(p => p.runId === first.runId)!;
    expect(second, "run was not republished").toBeTruthy();
    // Terminal-ize the run so it can't leak into the next case's republish sweep.
    await db.update(ciRuns).set({ status: "skipped" }).where(eq(ciRuns.id, first.runId));
    return { first, second };
  }

  it("THE BUG: a `static`-classified verify run must not re-deliver as privileged dind", async () => {
    const sa = await makeVerifyAgent();
    const chg = await makeChange("static", `rt-static-${S}`);
    const { first, second } = await bothDeliveries(sa, chg.id);
    expect(first.verifyTier).toBe("static");
    expect(first.dind).toBe(false);
    expect(second.verifyTier).toBe(first.verifyTier);
    expect(second.dind).toBe(first.dind);
  });

  it.each(["app", "services"])("a `%s` run keeps its tier on both deliveries", async tier => {
    const sa = await makeVerifyAgent();
    const chg = await makeChange(tier, `rt-${tier}-${S}`);
    const { first, second } = await bothDeliveries(sa, chg.id);
    expect(first.verifyTier).toBe(tier);
    expect(first.dind).toBe(false);
    expect(second.verifyTier).toBe(tier);
    expect(second.dind).toBe(false);
  });

  it("a pre-tier change (verifyTier NULL) falls back to `services` — fail-SAFE, not dind — on both paths", async () => {
    const sa = await makeVerifyAgent();
    const chg = await makeChange(null, `rt-null-${S}`);
    const { first, second } = await bothDeliveries(sa, chg.id);
    expect(first.verifyTier).toBe("services");
    expect(first.dind).toBe(false);
    expect(second.verifyTier).toBe("services");
    expect(second.dind).toBe(false);
  });

  it("a verify tick with NO change (schedule/continuous) behaves the same on both paths", async () => {
    const sa = await makeVerifyAgent();
    const { first, second } = await bothDeliveries(sa);
    expect(first.verifyTier).toBe("services");
    expect(first.dind).toBe(false);
    expect(second.verifyTier).toBe(first.verifyTier);
    expect(second.dind).toBe(first.dind);
  });

  it("a non-verify run carries no tier and never dind, on both paths", async () => {
    const sa = await makeVerifyAgent("worker");
    const { first, second } = await bothDeliveries(sa);
    expect(first.verifyTier).toBeUndefined();
    expect(first.dind).toBe(false);
    expect(second.verifyTier).toBeUndefined();
    expect(second.dind).toBe(false);
  });
});
