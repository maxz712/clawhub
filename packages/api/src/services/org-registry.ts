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
