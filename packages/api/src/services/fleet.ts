import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentRoles, agents, killSwitches, repositories, standingAgents } from "../models/schema.js";
import { listOrgAgents } from "./org-registry.js";
import { getQuality } from "./agent-quality.js";
import { monthSpend, orgSpend } from "./cost-ledger.js";
import { agentEarnedAutonomy } from "./agent-autonomy.js";
import { redactRole } from "./agent-roles.js";

// The fleet view: one aggregated snapshot of an org's agents — roles + their
// deployment counts, and every enrolled agent with trust tier, quality, monthly
// cost, kill state, and earned-autonomy. Unifies the org-registry + quality +
// cost + kill primitives so a team can run many agents from one pane.

export interface FleetAgent {
  agentId: string; name: string; trustTier: string;
  quality: { mergeRate: number; revertRate: number; driftScore: number } | null;
  monthCostCents: number; killed: boolean; earnedAutonomy: boolean;
}
export interface FleetRole { id: string; name: string; capability: string; specialization: string | null; deployments: number; earnedAutonomy: boolean }
export interface OrgFleet { orgSpendCents: number; roles: FleetRole[]; agents: FleetAgent[] }

export async function getOrgFleet(db: DB, orgId: string): Promise<OrgFleet> {
  // Roles owned by the org + their deployment counts.
  const roles = await db.select().from(agentRoles).where(and(eq(agentRoles.ownerType, "org"), eq(agentRoles.ownerId, orgId), eq(agentRoles.isTemplate, false)));
  const roleIds = roles.map(r => r.id);
  const counts = roleIds.length
    ? await db.select({ roleId: standingAgents.roleId, n: sql<number>`count(*)::int` }).from(standingAgents).where(inArray(standingAgents.roleId, roleIds)).groupBy(standingAgents.roleId)
    : [];
  const countByRole = new Map(counts.map(c => [c.roleId, Number(c.n)]));

  // The org's agents = registry-enrolled ones UNION agents with a standing
  // deployment on one of the org's repos (standing-attach / single-repo role
  // deploys aren't enrolled, but they ACT on the org and must show in the fleet
  // so an operator can govern them).
  const enrolled = await listOrgAgents(db, orgId);
  const enrolledIds = new Set(enrolled.map(e => e.agentId));
  const standingRows = await db.select({ agentId: standingAgents.agentId }).from(standingAgents)
    .innerJoin(repositories, eq(repositories.id, standingAgents.repoId))
    .where(and(eq(repositories.namespaceType, "org"), eq(repositories.namespaceId, orgId)));
  const extraIds = [...new Set(standingRows.map(r => r.agentId))].filter(id => !enrolledIds.has(id));
  const extraAgents = extraIds.length
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, extraIds))
    : [];
  const fleetSource: Array<{ agentId: string; name: string; trustTier: string }> = [
    ...enrolled.map(e => ({ agentId: e.agentId, name: e.name, trustTier: e.trustTier })),
    ...extraAgents.map(a => ({ agentId: a.id, name: a.name, trustTier: "unenrolled" })),
  ];

  const fleetAgents = await buildFleetAgents(db, fleetSource);

  return {
    orgSpendCents: await orgSpend(db, orgId).catch(() => 0),
    roles: roles.map(r => ({ ...redactRole(r), deployments: countByRole.get(r.id) ?? 0 } as unknown as FleetRole)),
    agents: fleetAgents,
  };
}

// Enrich a roster of agents with kill state + quality + monthly cost + earned
// autonomy — the shared core of both the org fleet and a solo user's personal
// fleet ("Solo = N=1; same code as a team fleet").
async function buildFleetAgents(db: DB, source: Array<{ agentId: string; name: string; trustTier: string }>): Promise<FleetAgent[]> {
  const killedSet = new Set<string>();
  if (source.length) {
    const ks = await db.select({ agentId: killSwitches.agentId }).from(killSwitches).where(inArray(killSwitches.agentId, source.map(e => e.agentId)));
    for (const k of ks) killedSet.add(k.agentId);
  }
  const out: FleetAgent[] = [];
  for (const e of source) {
    const q = await getQuality(db, e.agentId).catch(() => null);
    out.push({
      agentId: e.agentId, name: e.name, trustTier: e.trustTier,
      quality: q ? { mergeRate: q.mergeRate, revertRate: q.revertRate, driftScore: q.driftScore } : null,
      monthCostCents: await monthSpend(db, e.agentId).catch(() => 0),
      killed: killedSet.has(e.agentId),
      earnedAutonomy: await agentEarnedAutonomy(db, e.agentId).catch(() => false),
    });
  }
  return out;
}

// The caller's PERSONAL fleet: their claimed agents with the same quality/cost/
// kill/autonomy snapshot, plus their personal roles. `orgSpendCents` here is the
// sum of the user's agents' monthly spend (there's no org to bill). Same shape
// as `getOrgFleet` so the dashboard's FleetPane renders both unchanged.
export async function getMyFleet(db: DB, userId: string): Promise<OrgFleet> {
  const myAgents = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.associatedUserId, userId));
  const fleetAgents = await buildFleetAgents(db, myAgents.map(a => ({ agentId: a.id, name: a.name, trustTier: "personal" })));

  const roles = await db.select().from(agentRoles).where(and(eq(agentRoles.ownerType, "user"), eq(agentRoles.ownerId, userId), eq(agentRoles.isTemplate, false)));
  const roleIds = roles.map(r => r.id);
  const counts = roleIds.length
    ? await db.select({ roleId: standingAgents.roleId, n: sql<number>`count(*)::int` }).from(standingAgents).where(inArray(standingAgents.roleId, roleIds)).groupBy(standingAgents.roleId)
    : [];
  const countByRole = new Map(counts.map(c => [c.roleId, Number(c.n)]));

  return {
    orgSpendCents: fleetAgents.reduce((a, f) => a + f.monthCostCents, 0),
    roles: roles.map(r => ({ ...redactRole(r), deployments: countByRole.get(r.id) ?? 0 } as unknown as FleetRole)),
    agents: fleetAgents,
  };
}
