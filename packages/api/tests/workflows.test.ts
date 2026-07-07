import { describe, expect, it } from "vitest";
import { WORKFLOW_TEMPLATES, createWorkflow, dispatchWorkflow, updateWorkflow } from "../src/services/workflows.js";
import { createStandingAgent } from "../src/services/standing-agents.js";
import { hasTestDb, testDb } from "./test-db.js";
import { agents, branches, ciRuns, repoCollaborators, repositories, users, workflows } from "../src/models/schema.js";
import { and, eq } from "drizzle-orm";
import type { EventBus } from "../src/services/events.js";

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
});
