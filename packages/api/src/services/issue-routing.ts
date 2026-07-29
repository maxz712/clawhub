// Issue routing (N5) — mechanical label → agent assignment. Per-repo rules map a
// label (or "*" = any) to an agent; when a matching issue is created or gets a new
// label and is still unassigned, the highest-priority rule assigns it. No LLM —
// this is the deterministic "route the work" primitive, like risk-engine.
import { isNull, and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, issueRoutingRules, issues, repoCollaborators } from "../models/schema.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

export interface RoutableIssue { id: string; labels: unknown; assignedAgentId: string | null }

/**
 * True iff `agentId` holds a `repo_collaborators` grant (writer/reviewer) on the
 * repo — i.e. the agent can actually SEE and WORK the repo. This is the single
 * "can this agent be pointed at work here?" check; both automatic routing rules
 * (`setIssueRoutingRule`) and manual issue assignment (`routes/issues.ts`) reuse
 * it so an issue can never be assigned to an agent that can't act on it.
 */
export async function agentHasRepoGrant(db: DB, repoId: string, agentId: string): Promise<boolean> {
  const grant = (await db.select({ id: repoCollaborators.id }).from(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repoId), eq(repoCollaborators.agentId, agentId))).limit(1))[0];
  return !!grant;
}

/**
 * Assign an unassigned issue per the repo's routing rules. Highest `priority`
 * wins; at equal priority a specific-label rule beats a "*" wildcard. Only
 * assigns an agent that still holds a collaborator grant on the repo (a revoked
 * agent's rule is skipped, not honoured). Returns the assigned agentId or null.
 * Never overrides an explicit assignment.
 */
export async function applyIssueRouting(db: DB, repoId: string, issue: RoutableIssue): Promise<string | null> {
  if (issue.assignedAgentId) return null;
  const labels = Array.isArray(issue.labels) ? (issue.labels as string[]) : [];
  const rules = (await db.select().from(issueRoutingRules)
    .where(and(eq(issueRoutingRules.repoId, repoId), eq(issueRoutingRules.enabled, true))));
  const candidates = rules
    .filter(r => r.label === "*" || labels.includes(r.label))
    .sort((a, b) => (b.priority - a.priority) || ((a.label === "*" ? 1 : 0) - (b.label === "*" ? 1 : 0)));
  for (const rule of candidates) {
    // The agent must still be a collaborator (writer/reviewer) on this repo.
    const grant = (await db.select({ id: repoCollaborators.id }).from(repoCollaborators)
      .where(and(eq(repoCollaborators.repoId, repoId), eq(repoCollaborators.agentId, rule.agentId))).limit(1))[0];
    if (!grant) continue;
    // Conditional claim (#86): the "never overrides an explicit assignment"
    // guarantee was only checked in memory before the rule loop — a human
    // assigning between that read and this write was silently overwritten. The
    // WHERE re-asserts unassigned AT the write; zero rows = someone won the
    // race, and their assignment stands.
    const claimed = await db.update(issues)
      .set({ assignedAgentId: rule.agentId, updatedAt: new Date() })
      .where(and(eq(issues.id, issue.id), isNull(issues.assignedAgentId)))
      .returning({ id: issues.id });
    if (!claimed.length) { log("info", "issue_route_skipped_concurrent_assignment", { repoId, issueId: issue.id }); return null; }
    metrics.inc("clawhub_issue_routed_total", { label: rule.label });
    log("info", "issue_routed", { repoId, issueId: issue.id, agentId: rule.agentId, label: rule.label });
    return rule.agentId;
  }
  return null;
}

export interface RoutingRuleView {
  id: string; label: string; agentId: string; agentName: string | null; priority: number; enabled: boolean;
}

export async function listIssueRoutingRules(db: DB, repoId: string): Promise<RoutingRuleView[]> {
  const rows = await db.select({
    id: issueRoutingRules.id, label: issueRoutingRules.label, agentId: issueRoutingRules.agentId,
    priority: issueRoutingRules.priority, enabled: issueRoutingRules.enabled, agentName: agents.name,
  }).from(issueRoutingRules)
    .leftJoin(agents, eq(agents.id, issueRoutingRules.agentId))
    .where(eq(issueRoutingRules.repoId, repoId));
  return rows.sort((a, b) => b.priority - a.priority);
}

/** Upsert a rule keyed on (repo, label). Validates the agent has a repo grant. */
export async function setIssueRoutingRule(db: DB, repoId: string, input: { label: string; agentId: string; priority?: number; enabled?: boolean }): Promise<void> {
  const label = input.label.trim();
  if (!label) throw new Error("label required");
  if (!(await agentHasRepoGrant(db, repoId, input.agentId))) throw new Error("agent is not a collaborator on this repo");
  const row = {
    repoId, label, agentId: input.agentId,
    priority: input.priority ?? 0, enabled: input.enabled ?? true, updatedAt: new Date(),
  };
  await db.insert(issueRoutingRules).values(row)
    .onConflictDoUpdate({ target: [issueRoutingRules.repoId, issueRoutingRules.label], set: { agentId: row.agentId, priority: row.priority, enabled: row.enabled, updatedAt: row.updatedAt } });
}

export async function deleteIssueRoutingRule(db: DB, repoId: string, label: string): Promise<void> {
  await db.delete(issueRoutingRules).where(and(eq(issueRoutingRules.repoId, repoId), eq(issueRoutingRules.label, label)));
}
