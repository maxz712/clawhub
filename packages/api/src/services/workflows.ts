import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { metrics } from "./metrics.js";
import { planFor } from "./entitlements.js";
import { agents, changes, ciRuns, repositories, reviews, standingAgents, workflows } from "../models/schema.js";
import type { EventBus, ClawHubEvent } from "./events.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { parseCron, cronDue } from "./cron.js";
import { SLASH_WORKFLOWS } from "./agent-workflows.js";
import { dispatchStandingRun, standingAgentReachesRepoId, type DispatchResult } from "./standing-agents.js";
import { agentAccessConstraint, constraintCoversRepo } from "./access-roles.js";
import { callerContextRepos } from "./identities.js";
import { log } from "./logger.js";
import { namespaceNameOf } from "./namespace.js";

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
    // parseCron throws a plain Error on malformed input; surface it as a 400
    // ValidationError so a bad cron is a config-time client error, not a 500.
    try {
      parseCron(merged.cron);
    } catch (e) {
      throw new ValidationError(`invalid cron expression: ${(e as Error).message}`);
    }
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

/**
 * #43/#100: free-plan cap on ENABLED workflows (default 3, env-overridable) —
 * disabled workflows don't count, so pausing frees a slot. Paid plans are
 * uncapped here (their spend is governed by the platform quota layer). Shared
 * by createWorkflow and the disabled→enabled transition in updateWorkflow so
 * the PATCH path can't re-enable past the cap; `excludeWorkflowId` keeps the
 * workflow being updated out of its own count.
 */
async function assertFreePlanWorkflowSlot(db: DB, userId: string, opts: { excludeWorkflowId?: string } = {}): Promise<void> {
  const plan = await planFor(db, { userId });
  if (plan !== "free") return;
  const cap = Number(process.env.CLAWHUB_FREE_MAX_WORKFLOWS) || 3;
  const conds = [eq(standingAgents.createdByUserId, userId), eq(workflows.enabled, true)];
  if (opts.excludeWorkflowId) conds.push(ne(workflows.id, opts.excludeWorkflowId));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(workflows)
    .innerJoin(standingAgents, eq(workflows.standingAgentId, standingAgents.id))
    .where(and(...conds));
  if (Number(n) >= cap) {
    throw new ValidationError(`free plan is limited to ${cap} active workflows — pause one or upgrade`);
  }
}

export async function createWorkflow(db: DB, userId: string, input: WorkflowInput): Promise<WorkflowRow> {
  await deploymentFor(db, userId, input.standingAgentId);
  // Only an ENABLED create consumes a slot — creating paused drafts stays free
  // (the enable transition in updateWorkflow re-checks the cap).
  if (input.enabled !== false) await assertFreePlanWorkflowSlot(db, userId);
  const name = (input.name ?? "").trim();
  if (!name) throw new ValidationError("name required");
  const trigger = input.trigger ?? "manual";
  const merged = { trigger, cron: input.cron ?? null, event: input.event ?? null };
  validateWorkflow(input, merged);
  const repoScope = input.repoScope === "selected" ? "selected" : "all";
  const repoIds = repoScope === "selected" ? await assertCallerGovernsRepos(db, userId, input.repoIds ?? []) : [];
  return (await db.insert(workflows).values({
    standingAgentId: input.standingAgentId,
    name: name.slice(0, 120),
    instructions: (input.instructions ?? "").slice(0, 8000),
    trigger, cron: merged.cron, event: merged.event,
    intervalSec: Math.max(300, input.intervalSec ?? 3600),
    repoScope,
    repoIds,
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
  if (input.standingAgentId !== undefined) {
    await deploymentFor(db, userId, input.standingAgentId);
    patch.standingAgentId = input.standingAgentId;
  }
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 120);
  if (input.instructions !== undefined) patch.instructions = input.instructions.slice(0, 8000);
  if (input.trigger !== undefined) patch.trigger = merged.trigger;
  if (input.cron !== undefined) patch.cron = merged.cron;
  if (input.event !== undefined) patch.event = merged.event;
  if (input.intervalSec !== undefined) patch.intervalSec = Math.max(300, input.intervalSec);
  if (input.repoScope !== undefined) {
    patch.repoScope = input.repoScope === "selected" ? "selected" : "all";
    patch.repoIds = patch.repoScope === "selected" ? await assertCallerGovernsRepos(db, userId, input.repoIds ?? []) : [];
  } else if (input.repoIds !== undefined && wf.repoScope === "selected") {
    patch.repoIds = await assertCallerGovernsRepos(db, userId, input.repoIds);
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  // #100: re-enabling consumes a slot exactly like an enabled create — without
  // this, disable→create→re-enable cycles past the free-plan cap. Disabling
  // and non-enabled edits are never capped.
  if (input.enabled === true && !wf.enabled) {
    await assertFreePlanWorkflowSlot(db, userId, { excludeWorkflowId: id });
  }
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
 * The repos a deployment REACHES, newest-updated first and UNCAPPED: the
 * owner's governed repos kept to the agent's role scope. The fan-out cap is a
 * bounding knob applied per tick by the callers below — it must not leak into
 * a membership question, or a user with more repos than the cap could not
 * point a workflow at their own sixth repo.
 */
async function reachableRepos(db: DB, sa: typeof standingAgents.$inferSelect) {
  const ownerId = sa.createdByUserId
    ?? (await db.select({ associatedUserId: agents.associatedUserId }).from(agents).where(eq(agents.id, sa.agentId)).limit(1))[0]?.associatedUserId;
  if (!ownerId) {
    // No governing human: a legacy pinned row reaches only its own repo.
    return sa.repoId ? await db.select().from(repositories).where(eq(repositories.id, sa.repoId)) : [];
  }
  const governed = await callerContextRepos(db, ownerId);
  const constraint = await agentAccessConstraint(db, sa.agentId);
  const inScope = governed.filter(r => !constraint || constraintCoversRepo(constraint, r.id));
  // Newest-updated first — activity is where a workflow tick is worth spending.
  inScope.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return inScope;
}

/**
 * The repos ONE workflow tick fans out to. selected → the explicit list;
 * all → the repos the deployment reaches: the owner's governed repos, kept to
 * the agent's role scope, capped (newest first) so a tick is bounded.
 *
 * #120: the `selected` list is STORED INPUT, so it runs through the same
 * governed ∩ role-scope filter as `all` — defence in depth behind create-time
 * validation, so a foreign id persisted before this shipped (or through any
 * future write path) can never fan out.
 */
export async function resolveWorkflowRepos(db: DB, wf: WorkflowRow, sa: typeof standingAgents.$inferSelect): Promise<string[]> {
  const reachable = await reachableRepos(db, sa);
  if (wf.repoScope === "selected") {
    const allowed = new Set(reachable.map(r => r.id));
    // Preserve the user's own ordering for an explicit list; cap after filtering
    // so unreachable entries can't crowd out legitimate ones.
    return (wf.repoIds as string[]).filter(id => allowed.has(id)).slice(0, WORKFLOW_FANOUT_CAP);
  }
  return reachable.slice(0, WORKFLOW_FANOUT_CAP).map(r => r.id);
}

/**
 * #120: the repoIds a caller may pin a workflow to — those they GOVERN
 * (`callerContextRepos`, the same set the "all" scope draws from). Rejects
 * rather than silently drops: a scope picker that quietly discards a repo
 * looks like it worked and fails at dispatch time instead.
 */
async function assertCallerGovernsRepos(db: DB, userId: string, repoIds: string[]): Promise<string[]> {
  const clean = repoIds.filter((x): x is string => typeof x === "string").slice(0, 50);
  if (!clean.length) return clean;
  const governed = new Set((await callerContextRepos(db, userId)).map(r => r.id));
  const foreign = clean.filter(id => !governed.has(id));
  if (foreign.length) {
    throw new ForbiddenError(`repoIds includes ${foreign.length} repo(s) you don't govern`);
  }
  return clean;
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
  // #120: an EXPLICIT repoId short-circuits scope resolution — so it has to
  // carry its own authorization, or a caller-supplied id runs this agent
  // against any repo on the instance. Drop (rather than throw) so the event
  // and slash-command paths, which already authorize before calling here,
  // degrade to a no-op instead of aborting a fan-out mid-loop; the API
  // surfaces the 403 at the route, where the caller can see it.
  let repoIds: string[];
  if (opts.repoId) {
    repoIds = (await standingAgentReachesRepoId(db, sa, opts.repoId)) ? [opts.repoId] : [];
    if (!repoIds.length) {
      log("warn", "workflow_dispatch_forbidden_repo", { workflowId: wf.id, standingAgentId: sa.id, repoId: opts.repoId });
    }
  } else {
    repoIds = await resolveWorkflowRepos(db, wf, sa);
  }
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
    // #52: dispatch telemetry — count every workflow dispatch by trigger + outcome
    // so run volume and dispatch failures are graphable per trigger type.
    metrics.inc("clawhub_workflow_dispatch_total", { trigger: wf.trigger, ok: String(result.ok) });
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
  
  const repoById = new Map<string, { name: string; ns: string }>();
  for (const r of repoRows) {
    const ns = await namespaceNameOf(db, r.namespaceType, r.namespaceId);
    if (ns) {
      repoById.set(r.id, { name: r.name, ns });
    }
  }

  return runs.map(r => {
    const repoInfo = repoById.get(r.repoId);
    const repoName = repoInfo ? `${repoInfo.ns}/${repoInfo.name}` : null;
    return {
      id: r.id, status: r.status, commit: r.commit, changeId: r.changeId,
      repoId: r.repoId, repoName,
      task: r.dispatchTask, triggeredByUserId: r.triggeredByUserId,
      createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt,
      terminalReason: r.terminalReason ?? null,
      logUrl: r.logUrl,
      // The ACTIVITY the run produced (v4 framing).
      produced: {
        reviews: r.changeId ? (reviewsByChange.get(r.changeId) ?? []).map(x => ({ verdict: x.verdict, submittedAt: x.submittedAt })) : [],
      },
    };
  });
}
