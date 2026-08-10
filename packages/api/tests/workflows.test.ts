import { afterEach, describe, expect, it } from "vitest";
import {
  WORKFLOW_TEMPLATES, createWorkflow, dispatchWorkflow, handleEventForWorkflows,
  listWorkflowsFor, resolveWorkflowRepos, updateWorkflow, workflowReachesRepo,
} from "../src/services/workflows.js";
import { createStandingAgent, standingAgentReachesRepoId } from "../src/services/standing-agents.js";
import { buildMemoryPack, resolveScopeIds, writeMemory } from "../src/services/memory.js";
import { AppError, ForbiddenError, ValidationError } from "../src/services/errors.js";
import { hasTestDb, testDb } from "./test-db.js";
import { agents, branches, ciRuns, repoCollaborators, repositories, subscriptions, users, workflows } from "../src/models/schema.js";
import { and, eq } from "drizzle-orm";
import type { ClawHubEvent, EventBus } from "../src/services/events.js";

// v4 (docs/redesign-v4.md): workflows own instructions + cadence; deployments
// are repo-less; the target repo resolves at dispatch time.

const fakeEvents = { publish: async () => {} } as unknown as EventBus;

describe("workflow templates (pure)", () => {
  it("derives deploy-ready presets from the slash workflows", () => {
    const keys = WORKFLOW_TEMPLATES.map(t => t.key);
    for (const k of ["/dev", "/review", "/verify", "/scout", "/triage", "/loop"]) expect(keys).toContain(k);
    const review = WORKFLOW_TEMPLATES.find(t => t.key === "/review")!;
    // Templates prefill the slash FLAG — expansion stays server-side at dispatch.
    expect(review.instructions).toBe("/review");
    expect(review.suggestedTrigger).toBe("event");
    const dev = WORKFLOW_TEMPLATES.find(t => t.key === "/dev")!;
    expect(dev.suggestedTrigger).toBe("schedule");
    expect(dev.suggestedCron).toBeTruthy();
  });
});

describe.skipIf(!hasTestDb)("v4 workflows + repo-less deployments (db)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  async function seed() {
    const handle = `wf-${uniq()}`;
    const [user] = await testDb.insert(users).values({ email: `${handle}@t.local`, username: handle, passwordHash: "x" }).returning();
    const [repo] = await testDb.insert(repositories).values({ name: `r-${uniq()}`, namespaceType: "user", namespaceId: user.id, defaultBranch: "main" }).returning();
    await testDb.insert(branches).values({ repoId: repo.id, name: "main", headCommit: "a".repeat(40) });
    const [agent] = await testDb.insert(agents).values({
      name: `bot-${uniq()}`, tokenHash: "x", gitAuthorName: "b", gitAuthorEmail: "b@a.local",
      associatedUserId: user.id, createdByUserId: user.id,
    }).returning();
    return { user, repo, agent };
  }

  it("creates a GLOBAL deployment (no repo, no collaborator grant)", async () => {
    const { user, agent } = await seed();
    const sa = await createStandingAgent(testDb, {
      repoId: null, name: `dep-${uniq()}`, agentToken: undefined,
      agentName: agent.name, rotateToken: true,
      createdByUserId: user.id,
    } as Parameters<typeof createStandingAgent>[1]);
    expect(sa.repoId).toBeNull();
    const grants = await testDb.select().from(repoCollaborators).where(eq(repoCollaborators.agentId, sa.agentId));
    expect(grants.length).toBe(0);
  });

  it("workflow CRUD validates trigger config and stays editable", async () => {
    const { user, agent } = await seed();
    const sa = await createStandingAgent(testDb, {
      repoId: null, name: `dep-${uniq()}`, agentName: agent.name, rotateToken: true, createdByUserId: user.id,
    } as Parameters<typeof createStandingAgent>[1]);
    await expect(createWorkflow(testDb, user.id, {
      standingAgentId: sa.id, name: "bad", trigger: "schedule", cron: null,
    })).rejects.toThrow(/cron/);
    const wf = await createWorkflow(testDb, user.id, {
      standingAgentId: sa.id, name: "daily dev", instructions: "/dev", trigger: "schedule", cron: "0 6 * * *",
    });
    expect(wf.trigger).toBe("schedule");
    const edited = await updateWorkflow(testDb, user.id, wf.id, { instructions: "/dev focus on dark mode", trigger: "manual" });
    expect(edited.instructions).toContain("dark mode");
    expect(edited.trigger).toBe("manual");
  });

  it("rejects a malformed cron with a 400 ValidationError, not a 500 (#34)", async () => {
    const { user, agent } = await seed();
    const sa = await createStandingAgent(testDb, {
      repoId: null, name: `dep-${uniq()}`, agentName: agent.name, rotateToken: true, createdByUserId: user.id,
    } as Parameters<typeof createStandingAgent>[1]);

    // Create with a garbage cron → a client-facing 400, never an unhandled 500.
    const createErr = await createWorkflow(testDb, user.id, {
      standingAgentId: sa.id, name: "bad cron", trigger: "schedule", cron: "not a cron",
    }).catch(e => e);
    expect(createErr).toBeInstanceOf(ValidationError);
    expect((createErr as AppError).status).toBe(400);
    expect((createErr as Error).message).toMatch(/invalid cron/i);

    // Too-few fields is malformed too (parseCron: "expected 5 fields").
    await expect(createWorkflow(testDb, user.id, {
      standingAgentId: sa.id, name: "short cron", trigger: "schedule", cron: "0 6 * *",
    })).rejects.toBeInstanceOf(ValidationError);

    // A valid workflow can still be edited INTO an invalid cron → 400, not 500.
    const wf = await createWorkflow(testDb, user.id, {
      standingAgentId: sa.id, name: "daily", instructions: "/dev", trigger: "schedule", cron: "0 6 * * *",
    });
    const updateErr = await updateWorkflow(testDb, user.id, wf.id, { cron: "99 * * * *" }).catch(e => e);
    expect(updateErr).toBeInstanceOf(ValidationError);
    expect((updateErr as AppError).status).toBe(400);

    // A well-formed cron is still accepted (no false positives).
    const ok = await updateWorkflow(testDb, user.id, wf.id, { cron: "*/15 0-6 * * 1-5" });
    expect(ok.cron).toBe("*/15 0-6 * * 1-5");
  });

  describe("free-plan cap on ENABLED workflows (#43/#100)", () => {
    afterEach(() => { delete process.env.CLAWHUB_FREE_MAX_WORKFLOWS; });

    async function seedWithDeployment() {
      const { user, agent } = await seed();
      const sa = await createStandingAgent(testDb, {
        repoId: null, name: `dep-${uniq()}`, agentName: agent.name, rotateToken: true, createdByUserId: user.id,
      } as Parameters<typeof createStandingAgent>[1]);
      return { user, sa };
    }

    it("caps enabled creates, but a DISABLED create at cap still succeeds", async () => {
      process.env.CLAWHUB_FREE_MAX_WORKFLOWS = "2";
      const { user, sa } = await seedWithDeployment();
      await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "a" });
      await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "b" });
      const err = await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "c" }).catch(e => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/limited to 2 active workflows/);
      // Only ENABLED workflows consume a slot — a paused draft is always creatable.
      const draft = await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "draft", enabled: false });
      expect(draft.enabled).toBe(false);
    });

    it("PATCH re-enable at cap is rejected — the disable→create→re-enable bypass no longer works (#100)", async () => {
      process.env.CLAWHUB_FREE_MAX_WORKFLOWS = "2";
      const { user, sa } = await seedWithDeployment();
      await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "a" });
      const b = await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "b" });
      // The bypass walkthrough: pause one, create a replacement, re-enable the paused one.
      await updateWorkflow(testDb, user.id, b.id, { enabled: false });
      await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "c" });
      const err = await updateWorkflow(testDb, user.id, b.id, { enabled: true }).catch(e => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as AppError).status).toBe(400);
      expect((err as Error).message).toMatch(/limited to 2 active workflows/);
      const still = (await testDb.select().from(workflows).where(eq(workflows.id, b.id)))[0];
      expect(still.enabled).toBe(false);
    });

    it("re-enable UNDER cap succeeds, and the workflow never counts against itself", async () => {
      process.env.CLAWHUB_FREE_MAX_WORKFLOWS = "2";
      const { user, sa } = await seedWithDeployment();
      const a = await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "a" });
      await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "b" });
      await updateWorkflow(testDb, user.id, a.id, { enabled: false });
      const re = await updateWorkflow(testDb, user.id, a.id, { enabled: true });
      expect(re.enabled).toBe(true);
      // enabled:true on an already-enabled workflow is a no-op, not a new slot.
      const again = await updateWorkflow(testDb, user.id, a.id, { enabled: true });
      expect(again.enabled).toBe(true);
    });

    it("disabling and non-enabled edits are never blocked at cap", async () => {
      process.env.CLAWHUB_FREE_MAX_WORKFLOWS = "2";
      const { user, sa } = await seedWithDeployment();
      const a = await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "a" });
      await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "b" });
      const renamed = await updateWorkflow(testDb, user.id, a.id, { name: "a renamed", instructions: "/dev" });
      expect(renamed.name).toBe("a renamed");
      const paused = await updateWorkflow(testDb, user.id, a.id, { enabled: false });
      expect(paused.enabled).toBe(false);
    });

    it("paid plans are uncapped on create AND re-enable", async () => {
      process.env.CLAWHUB_FREE_MAX_WORKFLOWS = "2";
      const { user, sa } = await seedWithDeployment();
      await testDb.insert(subscriptions).values({ userId: user.id, plan: "pro", status: "active" });
      const made = [];
      for (const name of ["a", "b", "c", "d"]) {
        made.push(await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name }));
      }
      await updateWorkflow(testDb, user.id, made[0].id, { enabled: false });
      const re = await updateWorkflow(testDb, user.id, made[0].id, { enabled: true });
      expect(re.enabled).toBe(true);
    });

    it("default cap is 3 when the env override is unset", async () => {
      const { user, sa } = await seedWithDeployment();
      for (const name of ["a", "b", "c"]) await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name });
      const err = await createWorkflow(testDb, user.id, { standingAgentId: sa.id, name: "d" }).catch(e => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/limited to 3 active workflows/);
    });
  });

  it("'all' scope resolves the owner's governed repos and dispatch stamps workflow_id + repo", async () => {
    const { user, repo, agent } = await seed();
    const sa = await createStandingAgent(testDb, {
      repoId: null, name: `dep-${uniq()}`, agentName: agent.name, rotateToken: true, createdByUserId: user.id,
    } as Parameters<typeof createStandingAgent>[1]);
    const wf = await createWorkflow(testDb, user.id, {
      standingAgentId: sa.id, name: "scout", instructions: "/scout", trigger: "manual",
    });
    const wfRow = (await testDb.select().from(workflows).where(eq(workflows.id, wf.id)))[0];
    expect(wfRow.repoScope).toBe("all");

    const outcomes = await dispatchWorkflow(testDb, fakeEvents, wf, { manual: true, triggeredByUserId: user.id });
    expect(outcomes.length).toBeGreaterThan(0);
    const ok = outcomes.find(o => o.result.ok);
    expect(ok?.repoId).toBe(repo.id);
    const run = (await testDb.select().from(ciRuns).where(and(eq(ciRuns.workflowId, wf.id), eq(ciRuns.repoId, repo.id))))[0];
    expect(run).toBeTruthy();
    expect(run.origin).toBe("agent");
    expect(run.dispatchTask).toBe("/scout");
    expect(run.standingAgentId).toBe(sa.id);
  });

  // #120: the v4 target repo is CLIENT-SUPPLIED on every dispatch path, and
  // standingRunEnv derives the run's environment (memory pack, spec, changed
  // paths) FROM IT. Resolution without authorization = any account can point
  // its own agent at any repo on the instance. These pin the gate.
  describe("#120 dispatch authorizes the TARGET repo, not just the workflow", () => {
    async function seedAttackerAndVictim() {
      const victim = await seed();
      const attacker = await seed();
      const sa = await createStandingAgent(testDb, {
        repoId: null, name: `dep-${uniq()}`, agentName: attacker.agent.name, rotateToken: true,
        createdByUserId: attacker.user.id,
      } as Parameters<typeof createStandingAgent>[1]);
      return { victim, attacker, sa };
    }
    const runsFor = (repoId: string) => testDb.select().from(ciRuns).where(eq(ciRuns.repoId, repoId));

    it("(a) a manual run naming a FOREIGN repoId dispatches nothing", async () => {
      const { victim, attacker, sa } = await seedAttackerAndVictim();
      const wf = await createWorkflow(testDb, attacker.user.id, {
        standingAgentId: sa.id, name: "one-shot", instructions: "/verify", trigger: "manual",
      });

      const outcomes = await dispatchWorkflow(testDb, fakeEvents, wf, {
        repoId: victim.repo.id, manual: true, triggeredByUserId: attacker.user.id,
      });
      expect(outcomes).toEqual([]);
      expect(await runsFor(victim.repo.id)).toEqual([]);

      // Not a blanket block: the SAME explicit-repoId path still works on a repo
      // the deployment actually reaches.
      const own = await dispatchWorkflow(testDb, fakeEvents, wf, { repoId: attacker.repo.id, manual: true });
      expect(own.some(o => o.result.ok)).toBe(true);
      expect((await runsFor(attacker.repo.id)).length).toBe(1);
    });

    it("(a2) a PUBLIC foreign repo is refused too — public read is not participation", async () => {
      const { victim, attacker, sa } = await seedAttackerAndVictim();
      await testDb.update(repositories).set({ isPublic: true }).where(eq(repositories.id, victim.repo.id));
      expect(await standingAgentReachesRepoId(testDb, sa, victim.repo.id)).toBe(false);
      const wf = await createWorkflow(testDb, attacker.user.id, {
        standingAgentId: sa.id, name: "pub", instructions: "/verify", trigger: "manual",
      });
      await dispatchWorkflow(testDb, fakeEvents, wf, { repoId: victim.repo.id, manual: true });
      expect(await runsFor(victim.repo.id)).toEqual([]);
    });

    it("(b) a selected-scope workflow carrying a foreign repoId never fans out on that repo's event", async () => {
      const { victim, attacker, sa } = await seedAttackerAndVictim();
      const wf = await createWorkflow(testDb, attacker.user.id, {
        standingAgentId: sa.id, name: "watcher", instructions: "/verify",
        trigger: "event", event: "change.opened", repoScope: "selected", repoIds: [attacker.repo.id],
      });
      // The bad state create-time validation now prevents — written directly so
      // the resolver's own filter is what's under test (defence in depth).
      await testDb.update(workflows).set({ repoIds: [victim.repo.id] }).where(eq(workflows.id, wf.id));
      const stored = (await testDb.select().from(workflows).where(eq(workflows.id, wf.id)))[0];

      expect(await resolveWorkflowRepos(testDb, stored, sa)).toEqual([]);
      const n = await handleEventForWorkflows(testDb, fakeEvents, {
        type: "change.opened", repoId: victim.repo.id,
      } as ClawHubEvent);
      expect(n).toBe(0);
      expect(await runsFor(victim.repo.id)).toEqual([]);
    });

    it("(c) create/update refuse repoIds the caller doesn't govern", async () => {
      const { victim, attacker, sa } = await seedAttackerAndVictim();
      await expect(createWorkflow(testDb, attacker.user.id, {
        standingAgentId: sa.id, name: "pin", repoScope: "selected", repoIds: [victim.repo.id],
      })).rejects.toBeInstanceOf(ForbiddenError);

      const ok = await createWorkflow(testDb, attacker.user.id, {
        standingAgentId: sa.id, name: "pin-own", repoScope: "selected", repoIds: [attacker.repo.id],
      });
      expect(ok.repoIds).toEqual([attacker.repo.id]);

      // Both PATCH shapes: repoIds alone, and repoIds alongside repoScope.
      await expect(updateWorkflow(testDb, attacker.user.id, ok.id, { repoIds: [victim.repo.id] }))
        .rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateWorkflow(testDb, attacker.user.id, ok.id, { repoScope: "selected", repoIds: [victim.repo.id] }))
        .rejects.toBeInstanceOf(ForbiddenError);
      const unchanged = (await testDb.select().from(workflows).where(eq(workflows.id, ok.id)))[0];
      expect(unchanged.repoIds).toEqual([attacker.repo.id]);
    });

    it("(c2) the run-now guard: foreign repo denied, own repo and an INVITED repo allowed", async () => {
      const { victim, attacker, sa } = await seedAttackerAndVictim();
      // What routes/workflows.ts POST /standing-agents/:id/run throws its 403 on.
      expect(await standingAgentReachesRepoId(testDb, sa, victim.repo.id)).toBe(false);
      expect(await standingAgentReachesRepoId(testDb, sa, attacker.repo.id)).toBe(true);
      expect(await standingAgentReachesRepoId(testDb, sa, victim.user.id)).toBe(false); // not even a repo id

      // A cross-tenant agent the victim DELIBERATELY invited keeps working —
      // the bar is participation, not ownership.
      await testDb.insert(repoCollaborators).values({ repoId: victim.repo.id, agentId: sa.agentId, role: "reviewer" });
      expect(await standingAgentReachesRepoId(testDb, sa, victim.repo.id)).toBe(true);
    });

    it("(d) the foreign repo's memory pack can never reach a run (memory-index.ts:31-35 invariant)", async () => {
      const { victim, attacker, sa } = await seedAttackerAndVictim();
      await writeMemory(testDb, await resolveScopeIds(testDb, victim.agent.id, victim.repo.id), {
        kind: "convention", scope: "repo",
        title: `victim-only-${uniq()}`, body: "internal deploy runbook detail",
      });
      // The pack is scoped by the RUN's repo — an attacker's agent pinned there
      // would be handed the victim's notes verbatim. That's why dispatch, not
      // retrieval, has to be the gate.
      const leaked = await buildMemoryPack(testDb, await resolveScopeIds(testDb, attacker.agent.id, victim.repo.id));
      expect(leaked).toContain("internal deploy runbook detail");

      // ...and no dispatch path can produce such a run.
      const wf = await createWorkflow(testDb, attacker.user.id, {
        standingAgentId: sa.id, name: "exfil", instructions: "/verify", trigger: "manual",
      });
      await dispatchWorkflow(testDb, fakeEvents, wf, { repoId: victim.repo.id, manual: true });
      expect(await runsFor(victim.repo.id)).toEqual([]);
    });
  });

  // #144: WORKFLOW_FANOUT_CAP bounds one FAN-OUT tick. It was also being asked
  // the MEMBERSHIP question on the event path — so an `all`-scope (the default)
  // event workflow only ever fired on the 5 repos that happened to sort first,
  // and a Change opened on the owner's 6th repo dispatched nothing at all: no
  // review, no verify, no run row, no log line. The ordering key
  // (`repositories.updatedAt`) is bumped by settings/policy writes and never by
  // a push or a merge, so the set was stable — a repo that fell out stayed out.
  describe("#144 the fan-out cap bounds a tick, it is not a membership test", () => {
    const CAP = 5;   // WORKFLOW_FANOUT_CAP default (CLAWHUB_WORKFLOW_FANOUT_CAP unset)

    /** One owner + one global deployment + `n` repos, oldest-configured LAST. */
    async function seedManyRepos(n: number) {
      const { user, repo, agent } = await seed();
      const sa = await createStandingAgent(testDb, {
        repoId: null, name: `dep-${uniq()}`, agentName: agent.name, rotateToken: true, createdByUserId: user.id,
      } as Parameters<typeof createStandingAgent>[1]);
      // seed() already made repo #1; add the rest, then stamp updatedAt so the
      // FIRST repo is the newest and `repo` (the one we assert on) sorts LAST.
      const extra = [];
      for (let i = 1; i < n; i++) {
        const [r] = await testDb.insert(repositories).values({
          name: `r-${uniq()}`, namespaceType: "user", namespaceId: user.id, defaultBranch: "main",
        }).returning();
        await testDb.insert(branches).values({ repoId: r.id, name: "main", headCommit: "a".repeat(40) });
        extra.push(r);
      }
      // The oldest updatedAt = last in the fan-out order. Give the target repo
      // the oldest stamp so it is provably outside the capped top-N.
      await testDb.update(repositories).set({ updatedAt: new Date(Date.UTC(2020, 0, 1)) }).where(eq(repositories.id, repo.id));
      for (const [i, r] of extra.entries()) {
        await testDb.update(repositories).set({ updatedAt: new Date(Date.UTC(2026, 0, 2 + i)) }).where(eq(repositories.id, r.id));
      }
      return { user, agent, sa, target: repo, extra };
    }

    const runsFor = (repoId: string) => testDb.select().from(ciRuns).where(eq(ciRuns.repoId, repoId));

    it("dispatches an 'all'-scope event workflow on the owner's LAST-RANKED repo (was: silently never)", async () => {
      const { user, sa, target } = await seedManyRepos(CAP + 3);
      const wf = await createWorkflow(testDb, user.id, {
        standingAgentId: sa.id, name: "reviewer", instructions: "/review",
        trigger: "event", event: "change.opened",
      });
      const stored = (await testDb.select().from(workflows).where(eq(workflows.id, wf.id)))[0];
      expect(stored.repoScope).toBe("all");

      // The bug, pinned: the capped fan-out set does NOT contain the target...
      const fanout = await resolveWorkflowRepos(testDb, stored, sa);
      expect(fanout).toHaveLength(CAP);
      expect(fanout).not.toContain(target.id);
      // ...but membership is a different question, and the answer is yes.
      expect(await workflowReachesRepo(testDb, stored, sa, target.id)).toBe(true);

      const n = await handleEventForWorkflows(testDb, fakeEvents, {
        type: "change.opened", repoId: target.id,
      } as ClawHubEvent);
      expect(n).toBe(1);
      const runs = await runsFor(target.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].workflowId).toBe(wf.id);
      expect(runs[0].standingAgentId).toBe(sa.id);
    });

    it("ordering is irrelevant to event dispatch — every reachable repo fires, whatever its updatedAt rank", async () => {
      const { user, sa, target, extra } = await seedManyRepos(CAP + 3);
      const wf = await createWorkflow(testDb, user.id, {
        standingAgentId: sa.id, name: "verifier", instructions: "/verify",
        trigger: "event", event: "change.opened",
      });
      for (const r of [target, ...extra]) {
        await handleEventForWorkflows(testDb, fakeEvents, { type: "change.opened", repoId: r.id } as ClawHubEvent);
        expect((await runsFor(r.id)).length, `repo ${r.name} should have dispatched`).toBe(1);
      }
      void wf;
    });

    it("a repo OUTSIDE the deployment's reach still dispatches nothing (#120 unchanged)", async () => {
      const { user, sa } = await seedManyRepos(CAP + 3);
      const foreign = await seed();
      await createWorkflow(testDb, user.id, {
        standingAgentId: sa.id, name: "nosy", instructions: "/review",
        trigger: "event", event: "change.opened",
      });
      const n = await handleEventForWorkflows(testDb, fakeEvents, {
        type: "change.opened", repoId: foreign.repo.id,
      } as ClawHubEvent);
      expect(n).toBe(0);
      expect(await runsFor(foreign.repo.id)).toEqual([]);
    });

    it("'selected' scope is unchanged: listed repo fires, unlisted one doesn't", async () => {
      const { user, sa, target, extra } = await seedManyRepos(CAP + 3);
      const wf = await createWorkflow(testDb, user.id, {
        standingAgentId: sa.id, name: "pinned", instructions: "/review",
        trigger: "event", event: "change.opened", repoScope: "selected", repoIds: [target.id],
      });
      const stored = (await testDb.select().from(workflows).where(eq(workflows.id, wf.id)))[0];
      expect(await workflowReachesRepo(testDb, stored, sa, target.id)).toBe(true);
      expect(await workflowReachesRepo(testDb, stored, sa, extra[0].id)).toBe(false);

      expect(await handleEventForWorkflows(testDb, fakeEvents, { type: "change.opened", repoId: extra[0].id } as ClawHubEvent)).toBe(0);
      expect(await runsFor(extra[0].id)).toEqual([]);
      expect(await handleEventForWorkflows(testDb, fakeEvents, { type: "change.opened", repoId: target.id } as ClawHubEvent)).toBe(1);
      expect(await runsFor(target.id)).toHaveLength(1);
    });

    it("the SCHEDULED fan-out is still capped — 10 reachable repos, one tick spends 5", async () => {
      const { user, sa } = await seedManyRepos(10);
      const wf = await createWorkflow(testDb, user.id, {
        standingAgentId: sa.id, name: "daily dev", instructions: "/dev", trigger: "schedule", cron: "0 6 * * *",
      });
      const stored = (await testDb.select().from(workflows).where(eq(workflows.id, wf.id)))[0];
      expect(await resolveWorkflowRepos(testDb, stored, sa)).toHaveLength(CAP);
      // The fan-out a tick actually performs (no explicit repoId).
      const outcomes = await dispatchWorkflow(testDb, fakeEvents, stored);
      expect(outcomes).toHaveLength(CAP);
      expect(outcomes.filter(o => o.result.ok)).toHaveLength(CAP);
    });

    it("listWorkflowsFor reports the UNCAPPED reach + the cap, so 'all repos' can't lie", async () => {
      const { user, sa } = await seedManyRepos(CAP + 3);
      await createWorkflow(testDb, user.id, {
        standingAgentId: sa.id, name: "roster", instructions: "/review", trigger: "event", event: "change.opened",
      });
      const listed = (await listWorkflowsFor(testDb, user.id)).find(w => w.name === "roster")!;
      expect(listed.reachableRepoCount).toBe(CAP + 3);
      expect(listed.fanoutCap).toBe(CAP);
    });
  });
});
