import { and, eq, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgAgentRegistry, agents, orgMembers, repoCollaborators, repositories, standingAgents } from "../models/schema.js";
import { ForbiddenError, NotFoundError } from "./errors.js";

/**
 * An enrollment CONFERS governance authority over the agent — the kill switch,
 * blast-radius and cost caps all treat an org_agent_registry row as "this org
 * governs this agent" (routes/ops.ts:authorizeAgentGovernance). So enrollment
 * must require a real org↔agent relationship, not a bare admin-minted row about
 * ANY agent on the instance (#192). Accept only when the agent PROVABLY acts on
 * the org: its owner is a member, OR it has a standing deployment on an org-owned
 * repo, OR it holds a collaborator grant on one — the same non-forgeable joins
 * ops.ts already trusts. Otherwise 403 (404 for an absent agent). enrollAgent
 * itself stays a dumb writer so seeded/system callers (deployRoleToOrg, which has
 * ALREADY created the standing deployment) keep working; the gate lives at the
 * public enroll route + here for any future caller to reuse.
 */
export async function assertAgentEnrollable(db: DB, orgId: string, agentId: string): Promise<void> {
  const agent = (await db.select({ associatedUserId: agents.associatedUserId, serviceUserId: agents.serviceUserId })
    .from(agents).where(eq(agents.id, agentId)).limit(1))[0];
  if (!agent) throw new NotFoundError("agent");

  const ownerIds = [agent.associatedUserId, agent.serviceUserId].filter((x): x is string => !!x);
  if (ownerIds.length) {
    const member = (await db.select({ id: orgMembers.id }).from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), or(...ownerIds.map(id => eq(orgMembers.userId, id))))).limit(1))[0];
    if (member) return;
  }

  const standing = (await db.select({ id: standingAgents.id }).from(standingAgents)
    .innerJoin(repositories, eq(repositories.id, standingAgents.repoId))
    .where(and(eq(standingAgents.agentId, agentId), eq(repositories.namespaceType, "org"), eq(repositories.namespaceId, orgId))).limit(1))[0];
  if (standing) return;

  const collab = (await db.select({ id: repoCollaborators.id }).from(repoCollaborators)
    .innerJoin(repositories, eq(repositories.id, repoCollaborators.repoId))
    .where(and(eq(repoCollaborators.agentId, agentId), eq(repositories.namespaceType, "org"), eq(repositories.namespaceId, orgId))).limit(1))[0];
  if (collab) return;

  throw new ForbiddenError("agent has no relationship to this org");
}

export async function enrollAgent(db: DB, orgId: string, agentId: string, trustTier: "sandbox" | "standard" | "trusted" = "sandbox", approvedBy?: string) {
  await db.insert(orgAgentRegistry).values({ orgId, agentId, trustTier, approvedBy: approvedBy ?? null })
    .onConflictDoUpdate({ target: [orgAgentRegistry.orgId, orgAgentRegistry.agentId], set: { trustTier, approvedBy: approvedBy ?? null, approvedAt: new Date() } });
}

export async function revokeAgent(db: DB, orgId: string, agentId: string) {
  await db.delete(orgAgentRegistry).where(and(eq(orgAgentRegistry.orgId, orgId), eq(orgAgentRegistry.agentId, agentId)));
}

export async function listOrgAgents(db: DB, orgId: string) {
  return db.select({
    id: orgAgentRegistry.id,
    agentId: orgAgentRegistry.agentId,
    trustTier: orgAgentRegistry.trustTier,
    approvedAt: orgAgentRegistry.approvedAt,
    name: agents.name,
    gitAuthorName: agents.gitAuthorName,
    gitAuthorEmail: agents.gitAuthorEmail,
  }).from(orgAgentRegistry).innerJoin(agents, eq(agents.id, orgAgentRegistry.agentId)).where(eq(orgAgentRegistry.orgId, orgId));
}

export async function getAgentTierInOrg(db: DB, orgId: string, agentId: string): Promise<string | null> {
  const r = (await db.select().from(orgAgentRegistry).where(and(eq(orgAgentRegistry.orgId, orgId), eq(orgAgentRegistry.agentId, agentId))).limit(1))[0];
  return r?.trustTier ?? null;
}

/**
 * Agent NAMES enrolled at the `trusted` tier in this org's registry. These feed
 * `merge-policy.trustedAgents` for the org's repos: a `trusted` agent's review
 * counts toward the trusted-agent approval substitution on low-risk changes,
 * exactly like a per-repo `trustedAgents` entry — so the org-level trust tier
 * is an actual merge lever, not just a badge. (The registry tier ALSO gates
 * earned-autonomy self-merge as a restriction — see agent-autonomy.ts.)
 */
export async function trustedAgentNamesInOrg(db: DB, orgId: string): Promise<string[]> {
  const rows = await db.select({ name: agents.name })
    .from(orgAgentRegistry)
    .innerJoin(agents, eq(agents.id, orgAgentRegistry.agentId))
    .where(and(eq(orgAgentRegistry.orgId, orgId), eq(orgAgentRegistry.trustTier, "trusted")));
  return rows.map(r => r.name);
}
