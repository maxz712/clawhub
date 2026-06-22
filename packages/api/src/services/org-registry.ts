import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgAgentRegistry, agents } from "../models/schema.js";

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
