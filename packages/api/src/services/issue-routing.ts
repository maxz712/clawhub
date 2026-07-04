// Issue routing (N5) — mechanical label → agent assignment. Per-repo rules map a
// label (or "*" = any) to an agent; when a matching issue is created or gets a new
// label and is still unassigned, the highest-priority rule assigns it. No LLM —
// this is the deterministic "route the work" primitive, like risk-engine.
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, issueRoutingRules, issues, repoCollaborators } from "../models/schema.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

export interface RoutableIssue { id: string; labels: unknown; assignedAgentId: string | null }

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
    await db.update(issues).set({ assignedAgentId: rule.agentId, updatedAt: new Date() }).where(eq(issues.id, issue.id));
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
  const grant = (await db.select({ id: repoCollaborators.id }).from(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repoId), eq(repoCollaborators.agentId, input.agentId))).limit(1))[0];
  if (!grant) throw new Error("agent is not a collaborator on this repo");
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
