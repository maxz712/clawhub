// Unified async-job scheduling — the shared contract that turns every `ci_runs`
// row (CI *and* agent runs) into a schedulable job. See docs/job-scheduler-design.md.
//
// This module is PURE + dependency-light: priority bands, per-class resource
// requests, retry budgets, and the aging/placement math. The scheduler
// (run-scheduler.ts), the staleness subsystem (run-staleness.ts), and the enqueue
// sites all stamp/read through here so the policy lives in exactly one place.

/**
 * Static priority BANDS (Borg-style): higher = dispatched first. CI strictly
 * outranks agents; among agents, verify > review > develop > scout. The gap
 * between bands (100) is also the aging step ceiling — an agent can climb AT MOST
 * into the on:push-CI band, never into deploy. See AGE / effectivePriority below.
 */
export const PRIORITY = {
  deploy: 600, // on:merge deploy CI — rare, latency-critical, idempotent
  ci: 500, // on:push tests (+ fork-propose, update-branch re-run) — the merge-gate signal
  verify: 400, // native verifier + mode=verify agents — boots the app
  review: 300, // native advisory reviewer + mode=review — single-shot diff read
  develop: 200, // mode=develop / worker — builds + drives the UI
  scout: 100, // mode=scout / triage / reflect — files one issue
} as const;

/** The lowest band — a legacy/unclassified run sorts here (never above CI). */
export const MIN_PRIORITY_CLASS = PRIORITY.scout;

export type ResourceRequest = { cpus: number; memoryMb: number; timeoutSec: number; tier?: string };

// Per-class default sizing (docs table). Agent runs override cpu/mem/timeout from
// the operator-set standing_agents row; CI uses these directly.
const CI_DEFAULT: ResourceRequest = { cpus: 2, memoryMb: 3072, timeoutSec: 15 * 60 }; // 3GB tsc-OOM floor
const DEPLOY_DEFAULT: ResourceRequest = { cpus: 1, memoryMb: 512, timeoutSec: 30 * 60 };

const VERIFY_TIER_REQ: Record<string, ResourceRequest> = {
  static: { cpus: 0.5, memoryMb: 512, timeoutSec: 20 * 60, tier: "static" },
  app: { cpus: 1, memoryMb: 1024, timeoutSec: 30 * 60, tier: "app" },
  services: { cpus: 2, memoryMb: 2048, timeoutSec: 45 * 60, tier: "services" },
  dind: { cpus: 2, memoryMb: 3072, timeoutSec: 60 * 60, tier: "dind" },
};

const MODE_DEFAULT: Record<string, ResourceRequest> = {
  verify: VERIFY_TIER_REQ.services,
  review: { cpus: 0.5, memoryMb: 512, timeoutSec: 15 * 60 },
  develop: { cpus: 2, memoryMb: 2048, timeoutSec: 90 * 60 },
  worker: { cpus: 2, memoryMb: 2048, timeoutSec: 60 * 60 },
  triage: { cpus: 0.5, memoryMb: 512, timeoutSec: 20 * 60 },
  reflect: { cpus: 0.5, memoryMb: 512, timeoutSec: 20 * 60 },
  scout: { cpus: 0.5, memoryMb: 512, timeoutSec: 20 * 60 },
};

/** CI origin → priority band. A merge (or an explicitly deploy-shaped pipeline) is a deploy. */
export function ciPriorityClass(origin: string | null | undefined, isDeploy = false): number {
  if (origin === "merge" || isDeploy) return PRIORITY.deploy;
  return PRIORITY.ci; // push / schedule / event tests
}

/** Agent mode → priority band. Unknown/idle modes fall to the scout band. */
export function agentPriorityClass(mode: string | null | undefined): number {
  switch (mode) {
    case "verify":
      return PRIORITY.verify;
    case "review":
      return PRIORITY.review;
    case "develop":
    case "worker":
      return PRIORITY.develop;
    default:
      return PRIORITY.scout; // scout / triage / reflect / null
  }
}

/** Resource request for a CI run: the pipeline may size it; else the origin default. */
export function ciResourceRequest(origin: string | null | undefined, override?: Partial<ResourceRequest>): ResourceRequest {
  const base = origin === "merge" ? DEPLOY_DEFAULT : CI_DEFAULT;
  return { ...base, ...clean(override) };
}

/**
 * Resource request for an agent run. The operator-set limits on the standing_agents
 * row WIN (they are the real ask — e.g. a 4GB verify agent); the verify tier / mode
 * default only fills gaps. `tier` records the verify tier so the scheduler can keep
 * heavy tiers off the prod-co-located node.
 */
export function agentResourceRequest(
  agent: { mode?: string | null; memoryMb?: number | null; cpus?: number | null; timeoutSec?: number | null },
  verifyTier?: string | null,
): ResourceRequest {
  const tierReq = verifyTier ? VERIFY_TIER_REQ[verifyTier] : undefined;
  const base = tierReq ?? MODE_DEFAULT[agent.mode ?? "scout"] ?? MODE_DEFAULT.scout;
  return {
    cpus: agent.cpus ?? base.cpus,
    memoryMb: agent.memoryMb ?? base.memoryMb,
    timeoutSec: agent.timeoutSec ?? base.timeoutSec,
    ...(verifyTier ? { tier: verifyTier } : base.tier ? { tier: base.tier } : {}),
  };
}

/**
 * Retry budget. Retries only ever fire on TRANSIENT terminal reasons (a runner that
 * died / a stuck-no-progress reap) — never on a genuine reported failure. Two attempts
 * = one retry, which absorbs a self-deploy restart or a single flaky node without
 * re-running an expensive agent forever.
 */
export function defaultMaxAttempts(_kind: "ci" | "agent"): number {
  return 2;
}

/**
 * The scheduler stamp for a CI run — priority band, resource request, retry budget,
 * arch pin. Spread into the `ciRuns.values({...})` at every CI enqueue site so an
 * unstamped CI run can never default to the lowest band (which would let agents
 * outrank CI — the opposite of the requirement).
 */
export function ciSchedulingStamp(
  origin: string,
  opts: { isDeploy?: boolean; runsOn?: string | null; resource?: Partial<ResourceRequest> } = {},
): { priorityClass: number; resourceRequest: ResourceRequest; maxAttempts: number; runsOn: string | null } {
  return {
    priorityClass: ciPriorityClass(origin, opts.isDeploy),
    resourceRequest: ciResourceRequest(origin, opts.resource),
    maxAttempts: defaultMaxAttempts("ci"),
    runsOn: opts.runsOn ?? null,
  };
}

/** Terminal reasons an unfinished run can be closed with. */
export type TerminalReason = "success" | "failed" | "stale" | "superseded" | "stuck" | "preempted" | "canceled";

/** Retry is allowed only for transient infra reasons, and only if attempts remain. */
export function shouldRetry(reason: TerminalReason, attempts: number, maxAttempts: number): boolean {
  if (reason !== "stuck" && reason !== "preempted") return false; // superseded/stale/failed/canceled never retry
  return attempts + 1 < maxAttempts;
}

// ---- aging + placement math (used by run-scheduler.ts; pure + unit-tested) ----

// Aging: bands are 100 apart (scout 100 … deploy 600), so the aging term is on the
// SAME scale as the bands — it must be able to CROSS a band or it can't prevent
// starvation. Defaults: +1 every 6s → +100 (one full band) per 10 min waited.
export const AGE_STEP_SECONDS = Number(process.env.CLAWHUB_SCHED_AGE_STEP_S ?? 6);
export const CLASS_STEP = Number(process.env.CLAWHUB_SCHED_CLASS_STEP ?? 1);
/**
 * Cap on how far aging can lift a job: at most into the on:push-CI band (400 above
 * the scout band), never into deploy. So a scout (100) climbs to 500 after ~40 min
 * but a deploy (600) stays uncontestable — this turns "strict priority" into
 * "bounded wait" (W_max ≈ 40 min).
 */
export const MAX_AGE_CLIMB = Number(process.env.CLAWHUB_SCHED_MAX_CLIMB ?? PRIORITY.ci - PRIORITY.scout);

/** Effective priority = base band + capped aging term (same scale — aging can cross bands). */
export function effectivePriority(priorityClass: number | null | undefined, createdAt: Date, now: Date): number {
  const base = priorityClass ?? MIN_PRIORITY_CLASS;
  const waitedS = Math.max(0, (now.getTime() - createdAt.getTime()) / 1000);
  const climb = Math.min(Math.floor(waitedS / AGE_STEP_SECONDS) * CLASS_STEP, MAX_AGE_CLIMB);
  return base + climb;
}

export type NodeCapacity = {
  nodeId: string;
  nodeType?: string; // 'oci' | 'debian' | ...
  arch?: string; // 'x64' | 'arm64'
  cpusTotal: number;
  memTotalMb: number;
  cpusFree: number;
  memFreeMb: number;
  updatedAt?: number;
};

export const MIN_FREE_MB = Number(process.env.CLAWHUB_SCHED_MIN_FREE_MB ?? 384);

export function normArch(a: string | null | undefined): string | null {
  if (!a) return null;
  if (a === "x86_64" || a === "amd64" || a === "x64") return "amd64";
  if (a === "aarch64" || a === "arm64") return "arm64";
  return a;
}

/** Feasibility filter: can this node host this job right now without starving it? */
export function fits(node: NodeCapacity, req: ResourceRequest, runsOn?: string | null): boolean {
  if (runsOn && normArch(node.arch) && normArch(runsOn) !== normArch(node.arch)) return false;
  if (node.cpusFree < req.cpus) return false;
  if (node.memFreeMb < req.memoryMb) return false;
  if (node.memFreeMb - req.memoryMb < MIN_FREE_MB) return false; // leave headroom (don't starve the node)
  return true;
}

/** Worst-fit / spread score: higher = more room left after placement (spread across nodes). */
export function residualScore(node: NodeCapacity, req: ResourceRequest): number {
  const cpu = (node.cpusFree - req.cpus) / Math.max(1, node.cpusTotal);
  const mem = (node.memFreeMb - req.memoryMb) / Math.max(1, node.memTotalMb);
  return cpu + mem;
}

/** Drop undefined/null keys so a partial override doesn't clobber base values. */
function clean(o?: Partial<ResourceRequest>): Partial<ResourceRequest> {
  if (!o) return {};
  const out: Partial<ResourceRequest> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  return out;
}

