import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, repositories, standingAgents } from "../models/schema.js";
import type { EventBus } from "./events.js";
import type { TokenPayload } from "./auth.js";
import { SLASH_WORKFLOWS, type SlashWorkflow } from "./agent-workflows.js";
import { dispatchStandingRun } from "./standing-agents.js";
import { constraintCoversRepo, humanRoleGrants } from "./access-roles.js";
import { repoAccessFor } from "./repo-access.js";
import { hasPermission } from "./permissions.js";
import { getAuditLog } from "./audit.js";
import { log } from "./logger.js";

/**
 * v3 P4 — thread slash commands (docs/redesign-v3.md §4). `/review`, `/test`,
 * `/dev`, … typed at the START of a Change/Issue comment dispatch the SAME
 * server-side workflow expansion the scheduler uses (agent-workflows.ts) —
 * one grammar, two entry points, never a second slash system.
 *
 * Guard rails:
 *   - HUMAN commenters only, holding workflow:trigger (write access implies
 *     it; a role assignment can grant it narrower). Agent-authored comments
 *     NEVER trigger (anti-loop) — an echoed "/verify" in a bot reply is text.
 *   - The command must LEAD the comment; anything else is just a comment.
 *   - Trailing text enters the prompt only through expandWorkflowTask's
 *     operator-focus channel (fenced as instruction context, not parsed).
 *   - Billing: the run draws the REPO's budget exactly like a Run-now click;
 *     the asking human is stamped on the run (triggeredByUserId).
 * Kill switch: CLAWHUB_DISABLE_SLASH_COMMANDS=1.
 */

const ALIASES: Record<string, string> = {
  "/test": "/verify",
  "/check": "/verify",
};

export interface ParsedSlashCommand {
  command: string;            // canonical key into SLASH_WORKFLOWS
  workflow: SlashWorkflow;
  /** The raw task line passed to dispatch — canonical flag + operator focus. */
  task: string;
}

export function parseSlashCommand(body: string | null | undefined): ParsedSlashCommand | null {
  const t = (body ?? "").trim();
  const m = t.match(/^(\/[a-z-]+)\b([\s\S]*)$/i);
  if (!m) return null;
  const canonical = ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase();
  const wf = SLASH_WORKFLOWS[canonical];
  if (!wf) return null;
  // First line of trailing text becomes operator focus; the rest of a long
  // comment stays a comment (bounded prompt surface).
  const focus = m[2].split("\n")[0].trim().slice(0, 500);
  return { command: canonical, workflow: wf, task: focus ? `${canonical} ${focus}` : canonical };
}

export function slashCommandsEnabled(): boolean {
  return process.env.CLAWHUB_DISABLE_SLASH_COMMANDS !== "1";
}

/** write+ access carries workflow:trigger; else a role must grant it here. */
async function mayTriggerWorkflow(db: DB, repoId: string, userId: string, access: string): Promise<boolean> {
  if (access === "write" || access === "admin") return true;
  for (const grant of await humanRoleGrants(db, userId)) {
    if (constraintCoversRepo(grant, repoId) && hasPermission(grant.permissions, "workflow:trigger")) return true;
  }
  return false;
}

export interface SlashDispatchResult {
  dispatched: boolean;
  runId?: string;
  standingAgentName?: string;
  note?: string;
}

/**
 * Handle a freshly-stored comment that may lead with a slash command.
 * Best-effort: returns a result for the route to surface; never throws.
 */
export async function handleSlashComment(db: DB, events: EventBus, opts: {
  repoId: string;
  caller: TokenPayload;
  access: string;
  body: string;
  changeId?: string;
  issueNumber?: number;
}): Promise<SlashDispatchResult | null> {
  try {
    if (!slashCommandsEnabled()) return null;
    const parsed = parseSlashCommand(opts.body);
    if (!parsed) return null;
    // Humans only — an agent echoing a command in a reply must never loop.
    if (opts.caller.kind !== "user") return null;
    if (!(await mayTriggerWorkflow(db, opts.repoId, opts.caller.userId, opts.access))) {
      return { dispatched: false, note: "you need workflow:trigger (or write access) to launch workflows" };
    }
    // Target: enabled deployments that REACH this repo — repo-pinned rows
    // first, then GLOBAL (repo-less, v4) deployments whose agent has access
    // here. Mode-matching rows win; oldest first (stable choice). System
    // agents are excluded (they have their own dispatch discipline).
    const candidates = await db.select().from(standingAgents).where(and(
      or(eq(standingAgents.repoId, opts.repoId), isNull(standingAgents.repoId)),
      eq(standingAgents.enabled, true),
      eq(standingAgents.isSystem, false),
    )).orderBy(asc(standingAgents.createdAt));
    const repoRow = (await db.select().from(repositories).where(eq(repositories.id, opts.repoId)).limit(1))[0];
    const reachable: typeof candidates = [];
    for (const sa of candidates) {
      if (sa.repoId) { reachable.push(sa); continue; }
      // A global deployment responds only where its agent actually has
      // review+ access (association + role ceiling decide — repoAccessFor).
      if (!repoRow) continue;
      const agentRow = (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, sa.agentId)).limit(1))[0];
      if (!agentRow) continue;
      const access = await repoAccessFor(db, repoRow, { kind: "agent", agentId: sa.agentId, name: agentRow.name });
      if (access === "review" || access === "write" || access === "admin") reachable.push(sa);
    }
    const pinned = reachable.filter(sa => sa.repoId);
    const target = pinned.find(sa => sa.mode === parsed.workflow.mode)
      ?? reachable.find(sa => sa.mode === parsed.workflow.mode)
      ?? reachable[0];
    if (!target) {
      return { dispatched: false, note: `no deployment reaches this repo — deploy an agent in the Agents hub to use ${parsed.command}` };
    }
    // Change-thread commands pin to the change's exact head (verify/review
    // must attest THIS diff); issue commands point the agent at the issue.
    let commit: string | undefined;
    if (opts.changeId) {
      const ch = (await db.select({ headCommit: changes.headCommit }).from(changes).where(eq(changes.id, opts.changeId)).limit(1))[0];
      commit = ch?.headCommit;
    }
    const r = await dispatchStandingRun(db, events, target, {
      manual: true,
      task: parsed.task,
      changeId: opts.changeId,
      commit,
      issue: opts.issueNumber,
      triggeredByUserId: opts.caller.userId,
      // v4: a GLOBAL deployment runs against the thread's repo.
      repoId: opts.repoId,
    });
    void getAuditLog(db).record({
      repoId: opts.repoId, actorKind: "human", actorId: opts.caller.userId,
      action: "workflow.triggered", category: "ci",
      metadata: { command: parsed.command, standingAgentId: target.id, ok: r.ok, ...(r.ok ? { runId: r.runId } : { reason: r.reason }) },
    });
    if (!r.ok) {
      const notes: Record<string, string> = {
        duplicate: "an identical run for this head is already live",
        in_flight: "this agent already has a run in flight — it will pick up the latest state",
        rate_capped: "this agent hit its rate cap — try again later",
        over_budget: "this agent's cost budget is exhausted",
        killed: "this agent is kill-switched",
        disabled: "this agent is paused",
        unresolved: "the repo target could not be resolved",
      };
      return { dispatched: false, standingAgentName: target.name, note: notes[r.reason] ?? r.reason };
    }
    return { dispatched: true, runId: r.runId, standingAgentName: target.name };
  } catch (e) {
    log("warn", "slash_command_failed", { repoId: opts.repoId, err: (e as Error).message });
    return null;
  }
}
