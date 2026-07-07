import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, ciRuns, repositories, reviews, standingAgents, workflows } from "../models/schema.js";
import type { EventBus, ClawHubEvent } from "./events.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { parseCron, cronDue } from "./cron.js";
import { SLASH_WORKFLOWS } from "./agent-workflows.js";
import { dispatchStandingRun, type DispatchResult } from "./standing-agents.js";
import { agentAccessConstraint, constraintCoversRepo } from "./access-roles.js";
import { callerContextRepos } from "./identities.js";
import { log } from "./logger.js";

/**
 * v4 WORKFLOWS (docs/redesign-v4.md): the workflow is WHERE users tell an
 * agent what to do. A DEPLOYMENT (standing_agents) is identity + role +
 * provider only; the workflow carries the instructions (slash flag or natural
 * language), its OWN schedule/trigger, and an optional repo scope (default
 * "all" — every repo the deployment reaches). Each dispatched run stamps
 * ci_runs.workflow_id, so a workflow's activity history is one query. From
 * the user's perspective an agent run PRODUCES activity (a Change opened, a
 * review submitted) — runs surface those artifacts, not CI-ish steps.
 */

export type WorkflowRow = typeof workflows.$inferSelect;

const VALID_TRIGGERS = new Set(["manual", "schedule", "event", "continuous"]);
// Bound the all-repos fan-out of one tick — newest-active repos first.
const WORKFLOW_FANOUT_CAP = Number(process.env.CLAWHUB_WORKFLOW_FANOUT_CAP ?? 5);

export interface WorkflowInput {
  standingAgentId: string;
  name: string;
  instructions?: string;
  trigger?: string;
  cron?: string | null;
  event?: string | null;
  intervalSec?: number;
  repoScope?: "all" | "selected";
  repoIds?: string[];
  enabled?: boolean;
}

function validateWorkflow(input: Partial<WorkflowInput>, merged: { trigger: string; cron: string | null; event: string | null }): void {
  if (!VALID_TRIGGERS.has(merged.trigger)) throw new ValidationError(`bad trigger (${[...VALID_TRIGGERS].join("|")})`);
  if (merged.trigger === "schedule") {
    if (!merged.cron) throw new ValidationError("schedule trigger needs cron");
    parseCron(merged.cron); // throws on malformed
  }
  if (merged.trigger === "event" && !merged.event) throw new ValidationError("event trigger needs an event type");
  if (input.instructions !== undefined && input.instructions.length > 8000) throw new ValidationError("instructions too long (8KB)");
}

/** A deployment the caller governs: created by them, or their agent's. */
export async function deploymentFor(db: DB, userId: string, standingAgentId: string) {
  const sa = (await db.select().from(standingAgents).where(eq(standingAgents.id, standingAgentId)).limit(1))[0];
  if (!sa || sa.isSystem) throw new NotFoundError("deployment");
  if (sa.createdByUserId !== userId) {
    const a = (await db.select({ associatedUserId: agents.associatedUserId }).from(agents).where(eq(agents.id, sa.agentId)).limit(1))[0];
    if (a?.associatedUserId !== userId) throw new NotFoundError("deployment");
  }
  return sa;
}

export async function createWorkflow(db: DB, userId: string, input: WorkflowInput): Promise<WorkflowRow> {
  await deploymentFor(db, userId, input.standingAgentId);
  const name = (input.name ?? "").trim();
  if (!name) throw new ValidationError("name required");
  const trigger = input.trigger ?? "manual";
  const merged = { trigger, cron: input.cron ?? null, event: input.event ?? null };
  validateWorkflow(input, merged);
  const repoScope = input.repoScope === "selected" ? "selected" : "all";
  return (await db.insert(workflows).values({
    standingAgentId: input.standingAgentId,
    name: name.slice(0, 120),
    instructions: (input.instructions ?? "").slice(0, 8000),
    trigger, cron: merged.cron, event: merged.event,
    intervalSec: Math.max(300, input.intervalSec ?? 3600),
    repoScope,
    repoIds: repoScope === "selected" ? (input.repoIds ?? []).filter((x): x is string => typeof x === "string").slice(0, 50) : [],
    enabled: input.enabled !== false,
    createdByUserId: userId,
  }).returning())[0];
}

export async function updateWorkflow(db: DB, userId: string, id: string, input: Partial<WorkflowInput>): Promise<WorkflowRow> {
  const wf = (await db.select().from(workflows).where(eq(workflows.id, id)).limit(1))[0];
  if (!wf) throw new NotFoundError("workflow");
  await deploymentFor(db, userId, wf.standingAgentId);
  const merged = {
    trigger: input.trigger ?? wf.trigger,
    cron: input.cron !== undefined ? input.cron : wf.cron,
    event: input.event !== undefined ? input.event : wf.event,
  };
  validateWorkflow(input, merged);
  const patch: Partial<typeof workflows.$inferInsert> = {};
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 120);
  if (input.instructions !== undefined) patch.instructions = input.instructions.slice(0, 8000);
  if (input.trigger !== undefined) patch.trigger = merged.trigger;
  if (input.cron !== undefined) patch.cron = merged.cron;
  if (input.event !== undefined) patch.event = merged.event;
  if (input.intervalSec !== undefined) patch.intervalSec = Math.max(300, input.intervalSec);
  if (input.repoScope !== undefined) {
    patch.repoScope = input.repoScope === "selected" ? "selected" : "all";
    patch.repoIds = patch.repoScope === "selected" ? (input.repoIds ?? []).filter((x): x is string => typeof x === "string").slice(0, 50) : [];
  } else if (input.repoIds !== undefined && wf.repoScope === "selected") {
    patch.repoIds = input.repoIds.filter((x): x is string => typeof x === "string").slice(0, 50);
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  return (await db.update(workflows).set(patch).where(eq(workflows.id, id)).returning())[0];
}

export async function deleteWorkflow(db: DB, userId: string, id: string): Promise<void> {
  const wf = (await db.select().from(workflows).where(eq(workflows.id, id)).limit(1))[0];
  if (!wf) throw new NotFoundError("workflow");
  await deploymentFor(db, userId, wf.standingAgentId);
  await db.delete(workflows).where(eq(workflows.id, id));
}

/** Every workflow across the caller's deployments (with agent/deployment labels). */
export async function listWorkflowsFor(db: DB, userId: string) {
  const rows = await db.select({
    wf: workflows,
    deploymentName: standingAgents.name,
    agentId: standingAgents.agentId,
    agentName: agents.name,
    createdBy: standingAgents.createdByUserId,
    associatedUserId: agents.associatedUserId,
  }).from(workflows)
    .innerJoin(standingAgents, eq(standingAgents.id, workflows.standingAgentId))
    .innerJoin(agents, eq(agents.id, standingAgents.agentId))
    .orderBy(desc(workflows.createdAt));
  return rows
    .filter(r => r.createdBy === userId || r.associatedUserId === userId)
    .map(r => ({ ...r.wf, deploymentName: r.deploymentName, agentId: r.agentId, agentName: r.agentName }));
}

export async function workflowFor(db: DB, userId: string, id: string): Promise<WorkflowRow & { standingAgent: typeof standingAgents.$inferSelect }> {
  const wf = (await db.select().from(workflows).where(eq(workflows.id, id)).limit(1))[0];
  if (!wf) throw new NotFoundError("workflow");
  const sa = await deploymentFor(db, userId, wf.standingAgentId);
  return { ...wf, standingAgent: sa };
}

/**
 * The repos ONE workflow tick fans out to. selected → the explicit list;
 * all → the repos the deployment reaches: the owner's governed repos, kept to
 * the agent's role scope, capped (newest first) so a tick is bounded.
 */
export async function resolveWorkflowRepos(db: DB, wf: WorkflowRow, sa: typeof standingAgents.$inferSelect): Promise<string[]> {
  if (wf.repoScope === "selected") {
    return (wf.repoIds as string[]).slice(0, WORKFLOW_FANOUT_CAP);
  }
  const ownerId = sa.createdByUserId
    ?? (await db.select({ associatedUserId: agents.associatedUserId }).from(agents).where(eq(agents.id, sa.agentId)).limit(1))[0]?.associatedUserId;
  if (!ownerId) return sa.repoId ? [sa.repoId] : [];
  const governed = await callerContextRepos(db, ownerId);
  const constraint = await agentAccessConstraint(db, sa.agentId);
  const inScope = governed.filter(r => !constraint || constraintCoversRepo(constraint, r.id));
  // Newest-updated first — activity is where a workflow tick is worth spending.
  inScope.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return inScope.slice(0, WORKFLOW_FANOUT_CAP).map(r => r.id);
}

export interface WorkflowDispatchOutcome {
  repoId: string;
  result: DispatchResult;
}

/**
 * Dispatch a workflow: an explicit repo (thread/manual context) runs once;
 * otherwise the resolved scope fans out. Each run stamps workflow_id.
 */
export async function dispatchWorkflow(db: DB, events: EventBus, wf: WorkflowRow, opts: {
  repoId?: string; changeId?: string; commit?: string; issue?: number; manual?: boolean; triggeredByUserId?: string; focus?: string;
} = {}): Promise<WorkflowDispatchOutcome[]> {
  const sa = (await db.select().from(standingAgents).where(eq(standingAgents.id, wf.standingAgentId)).limit(1))[0];
  if (!sa) return [];
  const repoIds = opts.repoId ? [opts.repoId] : await resolveWorkflowRepos(db, wf, sa);
  const out: WorkflowDispatchOutcome[] = [];
  for (const repoId of repoIds) {
    const result = await dispatchStandingRun(db, events, sa, {
      repoId,
      task: wf.instructions + (opts.focus ? " " + opts.focus : ""),
      workflowId: wf.id,
      changeId: opts.changeId,
      commit: opts.commit,
      issue: opts.issue,
      manual: opts.manual,
      triggeredByUserId: opts.triggeredByUserId,
    });
    out.push({ repoId, result });
  }
  return out;
}

/**
 * Scheduler tick for schedule/continuous workflows. Compare-and-swap on
 * lastScheduledAt (mirrors pipeline-scheduler) so overlapping loops never
 * double-fire; dispatch's per-agent in-flight cap bounds the rest.
 */
export async function runWorkflowSchedulerTick(db: DB, events: EventBus, now: Date = new Date()): Promise<number> {
  let dispatched = 0;
  const due = await db.select().from(workflows).where(and(
    eq(workflows.enabled, true),
    inArray(workflows.trigger, ["schedule", "continuous"]),
  ));
  for (const wf of due) {
    let fire = false;
    if (wf.trigger === "schedule" && wf.cron) {
      if (wf.lastScheduledAt && wf.lastScheduledAt.getTime() > now.getTime()) {
        await db.update(workflows).set({ lastScheduledAt: now }).where(eq(workflows.id, wf.id));
        continue;
      }
      try { fire = cronDue(wf.cron, wf.lastScheduledAt ?? null, now); } catch { continue; }
    } else if (wf.trigger === "continuous") {
      fire = !wf.lastScheduledAt || now.getTime() - wf.lastScheduledAt.getTime() >= wf.intervalSec * 1000;
    }
    if (!fire) continue;
    // CAS claim — only one loop/process wins this tick.
    const claimed = await db.update(workflows)
      .set({ lastScheduledAt: now })
      .where(and(eq(workflows.id, wf.id),
        wf.lastScheduledAt ? eq(workflows.lastScheduledAt, wf.lastScheduledAt) : sql`${workflows.lastScheduledAt} IS NULL`))
      .returning({ id: workflows.id });
    if (!claimed.length) continue;
    const results = await dispatchWorkflow(db, events, wf).catch(e => {
      log("warn", "workflow_dispatch_failed", { workflowId: wf.id, err: (e as Error).message });
      return [] as WorkflowDispatchOutcome[];
    });
    dispatched += results.filter(r => r.result.ok).length;
  }
  return dispatched;
}

/**
 * Event-triggered workflows: on a matching ClawHub event, dispatch pinned to
 * the event's repo (and change head where present) — same family expansion as
 * the standing-agent event path.
 */
export async function handleEventForWorkflows(db: DB, events: EventBus, e: ClawHubEvent): Promise<number> {
  if (!e.repoId || e.type.startsWith("ci.")) return 0;
  const CHANGE_EVENTS = ["change.opened", "change.updated", "change.ready"];
  const matchTypes = CHANGE_EVENTS.includes(e.type) ? CHANGE_EVENTS : [e.type];
  const rows = await db.select().from(workflows).where(and(
    eq(workflows.enabled, true),
    eq(workflows.trigger, "event"),
    inArray(workflows.event, matchTypes),
  ));
  if (!rows.length) return 0;
  let dispatched = 0;
  for (const wf of rows) {
    // Scope check: the event's repo must be inside the workflow's reach.
    const sa = (await db.select().from(standingAgents).where(eq(standingAgents.id, wf.standingAgentId)).limit(1))[0];
    if (!sa) continue;
    if (wf.repoScope === "selected" && !(wf.repoIds as string[]).includes(e.repoId)) continue;
    if (wf.repoScope === "all") {
      const reach = await resolveWorkflowRepos(db, wf, sa);
      if (!reach.includes(e.repoId)) continue;
    }
    const changeId = (e as { changeId?: string }).changeId;
    let commit: string | undefined;
    if (changeId) {
      const ch = (await db.select({ headCommit: changes.headCommit, isDraft: changes.isDraft })
        .from(changes).where(eq(changes.id, changeId)).limit(1))[0];
      if (ch?.isDraft) continue; // reviewers only run on published diffs
      commit = ch?.headCommit;
    }
    const results = await dispatchWorkflow(db, events, wf, { repoId: e.repoId, changeId, commit });
    dispatched += results.filter(r => r.result.ok).length;
  }
  return dispatched;
}

// ---- templates (the marketplace the Templates page used to be) -------------

/** Curated workflow templates: the slash presets, deploy-ready. */
export const WORKFLOW_TEMPLATES = Object.entries(SLASH_WORKFLOWS).map(([flag, wf]) => ({
  key: flag,
  label: wf.label,
  mode: wf.mode,
  // The INSTRUCTIONS a template prefills are just the slash flag — expansion
  // happens server-side at dispatch, so an edited template stays honest.
  instructions: flag,
  description: wf.instructions,
  suggestedTrigger: flag === "/review" || flag === "/verify" ? "event" : "schedule",
  suggestedEvent: flag === "/review" || flag === "/verify" ? "change.opened" : null,
  suggestedCron: flag === "/review" || flag === "/verify" ? null : "0 6 * * *",
}));

// ---- activity ---------------------------------------------------------------

/**
 * A workflow's activity: its runs PLUS what each produced — the Change it
 * worked on and any review its agent submitted there. Framed as artifacts,
 * not CI steps (v4: "an agent run produces real activity").
 */
export async function workflowActivity(db: DB, wf: WorkflowRow, limit = 50) {
  const runs = await db.select().from(ciRuns)
    .where(eq(ciRuns.workflowId, wf.id))
    .orderBy(desc(ciRuns.createdAt)).limit(Math.min(200, limit));
  const sa = (await db.select({ agentId: standingAgents.agentId }).from(standingAgents).where(eq(standingAgents.id, wf.standingAgentId)).limit(1))[0];
  const changeIds = [...new Set(runs.map(r => r.changeId).filter((x): x is string => !!x))];
  const producedReviews = changeIds.length && sa
    ? await db.select({ id: reviews.id, changeId: reviews.changeId, verdict: reviews.verdict, submittedAt: reviews.submittedAt })
        .from(reviews).where(and(inArray(reviews.changeId, changeIds), eq(reviews.reviewerId, sa.agentId)))
    : [];
  const reviewsByChange = new Map<string, typeof producedReviews>();
  for (const r of producedReviews) {
    reviewsByChange.set(r.changeId, [...(reviewsByChange.get(r.changeId) ?? []), r]);
  }
  const repoIds = [...new Set(runs.map(r => r.repoId))];
  const repoRows = repoIds.length ? await db.select({ id: repositories.id, name: repositories.name, namespaceType: repositories.namespaceType, namespaceId: repositories.namespaceId }).from(repositories).where(inArray(repositories.id, repoIds)) : [];
  const repoById = new Map(repoRows.map(r => [r.id, r]));
  return runs.map(r => ({
    id: r.id, status: r.status, commit: r.commit, changeId: r.changeId,
    repoId: r.repoId, repoName: repoById.get(r.repoId)?.name ?? null,
    task: r.dispatchTask, triggeredByUserId: r.triggeredByUserId,
    createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt,
    terminalReason: r.terminalReason ?? null,
    // The ACTIVITY the run produced (v4 framing).
    produced: {
      reviews: r.changeId ? (reviewsByChange.get(r.changeId) ?? []).map(x => ({ verdict: x.verdict, submittedAt: x.submittedAt })) : [],
    },
  }));
}
