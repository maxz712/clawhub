// The unified async-job scheduler PASS. See docs/job-scheduler-design.md §4.
//
// Stateless: every pass recomputes ordering + placement from the pending `ci_runs`
// backlog + live per-node capacity heartbeats (Redis). It does NOT run jobs and does
// NOT own mutual exclusion — the atomic pending→running CAS in ci-runner stays the
// truth. The pass only STAMPS each pending run with `effectivePriority` (band + aging)
// and `assignedNode` (placement). Runners then claim only runs assigned to them.
//
// Enforcement is inert until CLAWHUB_SCHEDULER_ENABLED=on:
//   off    → does nothing (and clears any orphaned stamps → today's broadcast race).
//   shadow → computes + LOGS the placement, stamps nothing (validate on real traffic).
//   on     → stamps assignedNode (+ effectivePriority for observability); the claim CAS
//            gates on assignedNode.
// The claim-gate keys on assignedNode: a run with NO placement (assignedNode NULL —
// scheduler off, not-yet-placed, unplaceable, or reset-for-retry) is claimable by ANY
// node (the fallback), so the system still works if the scheduler is down and a stale
// stamp can never strand a run.

import Redis from "ioredis";
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciRuns, repositories } from "../models/schema.js";
import { effectivePriority as computeEff, fits, residualScore, type NodeCapacity, type ResourceRequest } from "./job-scheduling.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

// Runner nodes SADD themselves to this set + SETEX their capacity key (TTL ~15s).
// The runner (a separate package) writes with these exact key names — keep in sync.
export const NODES_SET = "clawhub:nodes";
export const nodeKey = (id: string): string => `clawhub:node:${id}`;

const DEFAULT_REQ: ResourceRequest = { cpus: 1, memoryMb: 1024, timeoutSec: 1800 };
const HEAVY_TIERS = new Set(["app", "services", "dind"]);

// v3 P6 — per-TENANT fair share for the standing tier (docs/redesign-v3.md §8):
// one noisy tenant's agent runs must not monopolize placement. Applies ONLY to
// agent-origin runs (the interactive/gating tier — pushes, CI, deploys — is
// never capped: a human is waiting on those). Counts RUNNING agent runs plus
// placements made this pass, keyed by the repo's owning namespace.
const TENANT_MAX_CONCURRENT_AGENT_RUNS = Number(process.env.CLAWHUB_TENANT_MAX_CONCURRENT_RUNS ?? 8);

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null, lazyConnect: true });
  return redis;
}

export function schedulerMode(): "off" | "shadow" | "on" {
  const v = (process.env.CLAWHUB_SCHEDULER_ENABLED ?? "off").toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}

/**
 * Record a runner node's live capacity (called from the node-heartbeat endpoint so
 * the runner never needs Redis creds). SADDs the node to the set + SETEXes its
 * capacity with a short TTL, so a node that stops heartbeating disappears (= down).
 */
export async function writeNodeCapacity(c: NodeCapacity, ttlSec = 15): Promise<void> {
  const r = getRedis();
  await r.connect().catch(() => {});
  await r.sadd(NODES_SET, c.nodeId);
  await r.set(nodeKey(c.nodeId), JSON.stringify({ ...c, updatedAt: Date.now() }), "EX", ttlSec);
}

/** Read live node capacities from Redis. A missing/expired key = node down (skipped). */
export async function readNodeCapacities(): Promise<NodeCapacity[]> {
  const r = getRedis();
  await r.connect().catch(() => {});
  let ids: string[] = [];
  try {
    ids = await r.smembers(NODES_SET);
  } catch {
    return [];
  }
  const out: NodeCapacity[] = [];
  for (const id of ids) {
    try {
      const raw = await r.get(nodeKey(id));
      if (!raw) continue; // expired → node considered down
      const c = JSON.parse(raw) as NodeCapacity;
      if (c && typeof c.cpusFree === "number" && typeof c.memFreeMb === "number") out.push(c);
    } catch {
      /* skip a corrupt/unreadable node entry */
    }
  }
  return out;
}

export type SchedulerPassResult = { placed: number; unplaceable: number; nodes: number };

/**
 * One scheduler pass. Fast-exits (returns null) when disabled, when no node is alive,
 * or when the backlog is empty — so it costs nothing on an idle system.
 */
export async function schedulerPass(db: DB, now: Date = new Date()): Promise<SchedulerPassResult | null> {
  const mode = schedulerMode();
  if (mode === "off") {
    // Graceful degradation: if the scheduler was turned OFF after having placed runs,
    // clear the orphaned placement stamps so those pending runs fall back to the
    // any-node broadcast race (the claim-gate keys on assignedNode). Cheap — matches
    // nothing on a system that was never enabled.
    await db.update(ciRuns).set({ assignedNode: null, effectivePriority: null })
      .where(and(eq(ciRuns.status, "pending"), or(isNotNull(ciRuns.assignedNode), isNotNull(ciRuns.effectivePriority))));
    return null;
  }

  const nodes = await readNodeCapacities();
  if (!nodes.length) return null; // nothing alive to place onto

  const pending = await db.select().from(ciRuns).where(eq(ciRuns.status, "pending")).orderBy(asc(ciRuns.createdAt));
  if (!pending.length) return null;

  // 1. ORDER: effective priority = band + capped aging; tie-break FCFS by createdAt.
  const jobs = pending
    .map(run => ({ run, eff: computeEff(run.priorityClass, run.createdAt, now) }))
    .sort((a, b) => b.eff - a.eff || a.run.createdAt.getTime() - b.run.createdAt.getTime());

  // Mutable capacity copy we deduct from as we place (the reservation effect).
  const cap: NodeCapacity[] = nodes.map(n => ({ ...n }));
  const assignments: Array<{ id: string; eff: number; node: string | null }> = [];
  let placed = 0;
  let unplaceable = 0;

  // Tenant fair share (agent runs only): repoId → tenant key, seeded with the
  // currently-RUNNING agent runs so the cap holds across passes.
  const repoIds = [...new Set(pending.map(r => r.repoId))];
  const repoRows = repoIds.length
    ? await db.select({ id: repositories.id, namespaceType: repositories.namespaceType, namespaceId: repositories.namespaceId })
        .from(repositories).where(inArray(repositories.id, repoIds))
    : [];
  const tenantOfRepo = new Map(repoRows.map(r => [r.id, `${r.namespaceType}:${r.namespaceId}`]));
  const tenantLoad = new Map<string, number>();
  const runningAgent = await db.select({ repoId: ciRuns.repoId }).from(ciRuns)
    .where(and(eq(ciRuns.status, "running"), eq(ciRuns.origin, "agent")));
  if (runningAgent.length) {
    const runningRepoIds = [...new Set(runningAgent.map(r => r.repoId))].filter(id => !tenantOfRepo.has(id));
    if (runningRepoIds.length) {
      const extra = await db.select({ id: repositories.id, namespaceType: repositories.namespaceType, namespaceId: repositories.namespaceId })
        .from(repositories).where(inArray(repositories.id, runningRepoIds));
      for (const r of extra) tenantOfRepo.set(r.id, `${r.namespaceType}:${r.namespaceId}`);
    }
    for (const r of runningAgent) {
      const t = tenantOfRepo.get(r.repoId);
      if (t) tenantLoad.set(t, (tenantLoad.get(t) ?? 0) + 1);
    }
  }

  // 2. PLACE top-down: Filter (feasibility) → Score (worst-fit / spread).
  for (const { run, eff } of jobs) {
    // Merge→deploy runs are HOST-BOUND: whichever runner claims one executes
    // scripts/self-deploy.sh on ITS OWN host, so "place by free resources" is
    // wrong by construction — the big worker node has the most room and does NOT
    // host the stack. Stamping it there stranded a prod deploy live (2026-07-06:
    // assignedNode=debian-server; debian never ran it, the claim-gate 409'd the
    // prod runner, the reaper failed it, master sat undeployed). Leave deploys
    // UNPLACED (assignedNode NULL → the pre-scheduler broadcast race, which the
    // deploy-capable node wins; CLAWHUB_RUNNER_NO_DEPLOY keeps worker nodes out).
    if (run.origin === "merge") { assignments.push({ id: run.id, eff, node: null }); unplaceable++; continue; }
    // Tenant fair share: an agent-origin run past its tenant's concurrent cap
    // stays unplaced this pass (it keeps aging and is retried next pass once a
    // sibling finishes). Interactive/gating runs (push/merge CI) are never capped.
    const tenant = run.origin === "agent" ? tenantOfRepo.get(run.repoId) : undefined;
    if (tenant && (tenantLoad.get(tenant) ?? 0) >= TENANT_MAX_CONCURRENT_AGENT_RUNS) {
      assignments.push({ id: run.id, eff, node: null });
      unplaceable++;
      continue;
    }
    const req = (run.resourceRequest as ResourceRequest | null) ?? DEFAULT_REQ;
    const feasible = cap.filter(n => fits(n, req, run.runsOn));
    let chosen: NodeCapacity | null = null;
    if (feasible.length) {
      // Heavy verify tiers avoid the prod-co-located node when a non-prod node fits,
      // so a whole-app boot never lands on the box running production.
      const heavy = !!req.tier && HEAVY_TIERS.has(req.tier);
      const pool = heavy && feasible.some(n => n.nodeType !== "oci") ? feasible.filter(n => n.nodeType !== "oci") : feasible;
      // Worst-fit: pick the node with the MOST residual room after placement (spread).
      chosen = pool.reduce((best, n) => (residualScore(n, req) > residualScore(best, req) ? n : best), pool[0]);
    }
    if (chosen) {
      chosen.cpusFree -= req.cpus;
      chosen.memFreeMb -= req.memoryMb;
      placed++;
      if (tenant) tenantLoad.set(tenant, (tenantLoad.get(tenant) ?? 0) + 1);
      assignments.push({ id: run.id, eff, node: chosen.nodeId });
    } else {
      unplaceable++;
      assignments.push({ id: run.id, eff, node: null }); // stays unplaced; a later pass retries with more age
    }
  }

  if (mode === "shadow") {
    log("info", "scheduler_shadow", { placed, unplaceable, nodes: cap.length, sample: assignments.slice(0, 8) });
    metrics.inc("clawhub_scheduler_pass_total", { mode: "shadow" });
    return { placed, unplaceable, nodes: nodes.length };
  }

  // mode === "on": stamp the decision. Guard on status='pending' so we never touch a
  // run that went terminal/running between the read and the write. An UNPLACEABLE run
  // (no feasible node) is stamped with a NULL node AND null effectivePriority so the
  // claim-gate's assignedNode-null fallback keeps it claimable by any runner (the
  // runner's own backpressure handles capacity) — a later pass re-places it if a node
  // frees up. Never leave a run assignedNode=null/effectivePriority=set (unclaimable).
  for (const a of assignments) {
    await db.update(ciRuns).set({ effectivePriority: a.node ? a.eff : null, assignedNode: a.node })
      .where(and(eq(ciRuns.id, a.id), eq(ciRuns.status, "pending")));
  }
  metrics.inc("clawhub_scheduler_pass_total", { mode: "on" });
  return { placed, unplaceable, nodes: nodes.length };
}
