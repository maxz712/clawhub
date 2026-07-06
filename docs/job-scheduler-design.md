# Unified Async-Job Scheduler for ClawHub

*A resource-aware, priority-ordered, starvation-free scheduler that both CI and agent
runs flow through — built on `ci_runs` + the event fanout + the pull-runner, not
replacing them.*

> **Status: BUILT (2026-07-05)** — shipped as `services/job-scheduling.ts` (priority bands + aging), `services/run-scheduler.ts` (the scheduler pass: Filter→Score placement, `assignedNode` stamps, staleness/stuck/supersede subsystem), node capacity heartbeats (`POST /api/v1/ci/nodes/heartbeat` from the runner), and the claim-gate in `services/ci-runner.ts` (assignedNode-keyed CAS with the NULL-placement broadcast fallback). Gated by the scheduler mode env; heavy verify tiers prefer the big node. The text below is the design of record.
>
> Originally design / research (2026-07-05). Motivated by a live incident: a heavyweight
> `develop`-mode agent run was scheduled onto the 2-cpu OCI box (co-located with prod),
> saturated both cores, never came up healthy in 18 min, and would have starved against
> its timeout — while the idle 12-cpu debian box sat unused. Today there is **no scheduler**:
> runs are broadcast and raced-for, with no priority, no cross-node resource awareness, and
> no anti-starvation beyond a stale-run republisher.

---

## 0. Design stance in one paragraph

Keep everything ClawHub already has — one `ci_runs` table, the `ci.run.queued` fanout, the
atomic `pending→running` CAS, the pull-runners — and insert **one small central scheduler
pass** that owns *ordering* and *placement*. The scheduler does not run jobs and does not own
mutual exclusion (the CAS still does). It reads the pending `ci_runs` backlog + live per-node
capacity heartbeats, computes a **Slurm-style effective priority** (Borg priority bands +
Slurm age term), runs a **Kubernetes/Nomad Filter→Score** placement (worst-fit/spread for a
2-node box), and stamps each pending run with `assigned_node` + `effective_priority`. Runners
claim only runs assigned to them, highest-effective-priority first. No k8s, no Nomad daemon —
we borrow the proven **algorithms**, not the heavyweight machinery.

---

## 1. Recommended composition (one choice)

**Central assignment computed on a periodic pass, executed by pull-runners, with the existing
CAS as the final guard.** Four composed mechanisms:

| Concern | Mechanism | Derived from |
|---|---|---|
| **Queue ordering** | Single integer `effective_priority = base_band*1000 + min(floor(wait/AGE_STEP)*CLASS_STEP, MAX_CLIMB)`, capped so an agent climbs *to but not past* the on:push-CI band | Borg priority bands + Slurm multifactor `age_factor` |
| **Placement** | Two-phase **Filter** (drop nodes failing arch / headroom / fit) → **Score** (worst-fit / spread by residual dominant-share) | k8s kube-scheduler Filter→Score→Bind; Nomad feasibility→rank (flipped bin-pack→spread for 2 nodes) |
| **Starvation floor** | Aging (above) + a static reserved agent slot; **no preemption** except deploy-over-agent | Slurm age term; classic priority-aging; Borg-band exception |
| **Backfill** | Depth-1 EASY backfill: reserve the head job that can't fit; let a cheap agent job run in the leftover hole if its hard-timeout finishes before the reservation | Slurm EASY backfill |

**Why this composition and not the alternatives**

- **Not full DRF/YARN/Mesos fairness.** The requirement is *strict* "CI > agents", not a
  proportional cpu+mem split between two tenant-classes. DRF's value ("equalize dominant
  shares") only appears under multi-tenant contention at scale; at N=2 nodes and 2 workload
  classes it's overkill. Keep DRF as the documented upgrade path, not v1.
- **Not preemption-first (k8s/Borg).** Killing a mid-flight `develop`/`verify` run wastes LLM
  tokens and can leave a half-pushed branch. Aging gives the same *bounded-wait* guarantee
  without destroying work.
- **Not a persistent push scheduler.** ClawHub runners are pull-based and idle agents must
  cost nothing; a watch-driven daemon per node fights that model. A periodic SQL pass over
  `ci_runs` with an empty-queue fast-exit costs nothing when there's no work.
- **Aging is mandatory, not optional.** EASY backfill + strict priority *alone* only protect
  the single head job; jobs behind it starve forever (the classic HPC failure mode). The
  additive age term turns "strict-ish priority" into "bounded wait for every job".

One line: **Borg bands for CI>agents · Slurm aging for guaranteed anti-starvation · k8s/Nomad
Filter→Score(spread) for placement · a reserved agent slot as the floor · EASY backfill for
utilization — all over the existing `ci_runs` + pull-runner + Postgres/Redis substrate.**

---

## 2. The job abstraction

Every async job is already a `ci_runs` row. Today `memoryMb/cpus/timeoutSec` ride only in the
transient `ci.run.queued` payload and are *lost on re-dispatch* — that gap must close for a
scheduler to bin-pack. New persisted columns on `ci_runs`:

```
ci_runs (added)
  priority_class     smallint    -- static base band (see table)
  resource_request   jsonb       -- {cpus, memoryMb, timeoutSec, tier}
  runs_on            text        -- arch pin 'amd64'|'arm64'|null(any) (persist the payload value)
  assigned_node      text        -- scheduler's placement decision; null = unplaced
  effective_priority int         -- last-computed band+age; for claim ORDER BY + observability
  scheduled_at       timestamptz -- when the scheduler last stamped assigned_node
```

**Aging clock = `createdAt`, never reset on re-publish.** The stale-pending republishers
(`republishStalePendingStandingRuns`, `republishStalePendingPipelineRuns`) re-emit the SSE
frame but must NOT touch `createdAt` — otherwise a repeatedly-redispatched job resets its age
and starves silently. (They already only re-publish, so this is preserved by construction.)

**Priority classes** (higher = dispatched first):

| class | value | job kind | `resource_request` (cpu / mem) | why that size |
|---|---|---|---|---|
| deploy | 600 | `on:merge` deploy CI | 1 / 512M | rare, latency-critical, idempotent |
| on:push CI | 500 | `on:push` tests, fork-propose, update-branch re-run | 2 / 3072M | the **3GB tsc-OOM floor** from the CI OOM incident |
| verify | 400 | native verifier + `mode=verify` agents | static 0.5/512M · app 1/1G · services 2/2G · dind 2/3G | boots app + Chromium |
| review | 300 | native advisory reviewer + `mode=review` (`reviewOnly`, no clone) | 0.5 / 512M | single-shot diff read |
| develop | 200 | `mode=develop` / worker | 2 / 2G | builds + drives UI |
| scout | 100 | `mode=scout` / triage / reflect | 0.5 / 512M | files one issue |

`on:schedule` / `on:event` CI map by their pipeline's role (a deploy-shaped event→600, a
test-shaped one→500), resolved from `origin` + pipeline config.

**How each existing job becomes an instance.** The mapping is already latent in the `origin`
column (`push|merge|schedule|event|agent`). We formalize it at two kinds of site:

- **CI enqueue sites** (`post-push.ts`, `changes.ts:merge`, `changes.ts:updateBranch`,
  `ci-trigger.ts:enqueueTriggeredRun`, `forks.ts`) stamp `priority_class` from `origin` and
  `resource_request` from the pipeline (or the CI default 2/3072M).
- **Every agent kind** funnels through the single spine `standing-agents.ts:dispatchStandingRun`
  (standing agents, agent roles, native reviewer, native verifier). Stamp `priority_class`
  from the agent's `mode` and copy `resource_request` from `standing_agents.{memoryMb,cpus,
  timeoutSec}` + the resolved `verifyTier`. One edit point covers all six agent modes + both
  system agents.

A shared helper `queueRun(row)` centralizes the stamp so every site is consistent.

---

## 3. Node / capacity model

Two heterogeneous nodes, **advertised, not inferred**. The runner already computes the exact
signal we need locally (`waitForHostHeadroom`: `os.loadavg()[0]/cores` + `os.freemem()`); lift
it up instead of keeping it per-process.

**Heartbeat** — each runner writes a Redis key every ~5s (TTL ~15s so a dead node vanishes):

```
node_capacity[node_id] = {
  node_type: 'oci' | 'debian', arch: 'x64'|'arm64',
  cpus_total, mem_total_mb, cpus_free, mem_free_mb,
  running_runs: [{runId, cpus, memMb}], heavy_slots_free, updated_at
}
```

A missing/expired key = node **down** (heartbeat is the liveness signal).

**Avoiding a starved node — two guards:**
1. **Filter (feasibility):** drop a node if `cpus_free < req.cpus`, `mem_free_mb < req.memMb`,
   arch mismatch, or below a hard headroom floor (`mem_free_mb < MIN_FREE_MB=384`,
   `load_per_core > MAX_LOAD_PER_CORE`). This is literally "don't schedule onto an
   already-starved node".
2. **Score (spread):** among feasible nodes pick the one with the **most** residual room after
   placement (**worst-fit**), not the tightest (bin-pack) — for a 2-node box you spread to
   avoid starving a node.

**OCI headroom for prod** (the OCI box is co-located with prod):
- **Reserved headroom (subtract-before-advertise):** the OCI runner advertises `cpus_free`/
  `mem_free_mb` *already minus* a static prod reserve (`CLAWHUB_NODE_PROD_RESERVE_CPUS/_MEM_MB`,
  e.g. 1 vCPU / 2GB). The scheduler literally cannot see that headroom, so it can never place
  onto it.
- **`deferHeavyTier` becomes a scheduler input, not a local opt-out:** the scheduler won't
  place `verify` tiers app/services/dind onto the OCI node while the debian node is feasible —
  heavy work goes to the big box by construction.
- **Last-resort protector unchanged:** the runner's `cpu_shares` + `waitForHostHeadroom`
  admission gate stays as the kernel-level backstop even after assignment (a stale heartbeat
  can't overcommit prod because the runner still refuses at claim time).

---

## 4. The scheduler loop (pseudocode)

Runs inside the existing central loop `standing-agent-scheduler.ts:runStandingTick` (it already
republishes stale runs and owns the global pending view). Tick ~5s; cheap because it fast-exits
on an empty backlog.

```text
function schedulerPass():
  nodes = readLiveNodeCapacities()               # Redis node_capacity[*], expired = down
  if nodes empty: return
  pending = SELECT * FROM ci_runs
            WHERE status='pending' AND assigned_node IS NULL ORDER BY createdAt
  if pending empty: return                        # ZERO cost when idle (req 6)

  # 1. ORDER: effective priority = band + aging
  now = clock()
  for job in pending:
    wait  = now - job.createdAt                                    # NEVER reset by republish
    climb = min(floor(wait / AGE_STEP) * CLASS_STEP, MAX_CLIMB)    # cap below CI band
    job.eff = job.priority_class * 1000 + climb
  sort pending by (eff DESC, createdAt ASC)

  cap = deepcopy(nodes); reservation = null

  # 2. PLACE: Filter -> Score(worst-fit), top-down
  for job in pending:
    feasible = [n for n in cap if fits(n, job)]   # arch + cpu + mem + headroom floor
    if feasible:
      node = argmax(feasible, key = residualScore) # WORST-FIT / spread (DRF-flavored tiebreak)
      assign(job, node)                            # stamp assigned_node + effective_priority
      deduct(cap[node], job.req)
    else:
      if reservation is null: reservation = job    # EASY depth-1: reserve the head only
      # 3. BACKFILL: a lower job may run now IFF it fits AND its hard timeout
      #    finishes before reservation's projected start (2h reaper = the walltime bound)
      continue
  # unassigned rows stay pending; next pass re-evaluates with fresh capacity + more age
```

**Dispatch after assignment.** Re-`publish` the `ci.run.queued` frame carrying `assigned_node`.
Runners claim only frames whose `assigned_node === MY_NODE_ID` (new check beside the existing
`runsOn` check in `subscribeOnce`), ordered `effective_priority DESC, createdAt ASC`. The
atomic CAS in `ci-runner.ts:updateRunFromRunner` stays the final guard (assignment is advisory,
the CAS is truth) — the scheduler stays out of the mutual-exclusion path.

**Constants (env-tunable):** `CLASS_STEP=100`, `AGE_STEP=60s` (~+1 class-step / 10 min waited),
`MAX_CLIMB=400` (a scout at 100 can climb to 500, the on:push band, after ~40 min but **never
past deploy=600**; bounded worst-case wait `W_max ≈ 40–50 min`). `MIN_FREE_MB=384`,
`MAX_LOAD_PER_CORE=2.0` (heavy 1.25) — the runner's existing floors.

**Preemption policy.** *None* in v1 except one Borg-band exception: **deploy (600) may preempt
exactly one running agent (never CI), only when no node fits.** Require a priority delta > 200
(Nomad-style anti-cascade) so CI never preempts CI and agents never preempt each other.
Everything else is queue-jump + aging.

---

## 5. Why idle agents cost nothing + stale/duplicate avoidance

**Trigger → enqueue only.** A `continuous`/`schedule`/`event` standing agent is just scheduling
*state* on the `standing_agents` row; it consumes zero compute until a tick materializes a
`ci_runs` row. The scheduler pass fast-exits on an empty backlog — no daemon, no per-node
polling, no offer churn. The scheduler *adds* an ordering/placement decision only when there is
something pending to order.

**One new admission nuance the current system lacks:** because the scheduler sees the *whole*
pending set, an agent tick that lands while CI is queued sorts *below* the CI and waits — the
missing "defer this agent because CI is queued" decision now exists for free, as a consequence
of ordering. Idle agents still cost nothing; *contended* agents defer.

**Stale / duplicate avoidance — reuse the proven idempotency, don't add a second one:**
- Idempotent dispatch unchanged: `dispatchStandingRun` per-agent advisory lock + partial unique
  index on pending standing runs.
- At-least-once redelivery unchanged: republishers re-emit stale-pending frames; the scheduler
  re-stamps `assigned_node` on the next pass (idempotent — same row, same decision unless
  capacity moved).
- Cross-runner de-dup unchanged: the atomic `pending→running` CAS. `assigned_node` *narrows* the
  race (usually one runner even tries) but the CAS remains the correctness guarantee.
- **Aging-clock integrity (the one new invariant):** republish must not touch `createdAt`.

The scheduler is *purely additive* to the existing three-layer idempotency; it introduces no new
mutual-exclusion surface.

---

## 6. Pull vs push decision

**Keep runners pulling, but make claims scheduler-gated + node-assigned + priority-ordered.**
Not central-assign-and-push.

- **Idle cost:** pull with an empty queue = no cost. A push scheduler needs a live connection per
  node it drives — the model we'd be fighting.
- **Blast radius:** the authoritative claim (the CAS) already exists and de-dups. A push design
  would have to own mutual exclusion + node liveness itself; pull lets the CAS stay the single
  source of truth.
- **Failure tolerance:** if the scheduler pass is late or a node dies, pull-runners with the
  existing republisher + reaper still make progress (degrades to today's broadcast race). A
  central pusher is a hard dependency in the hot path.

**Fallback flag:** null `assigned_node` (scheduler down / flag off) → runners fall back to today's
local-filter broadcast race. The scheduler is an optimization layer over a system that still
works without it.

---

## 7. Staged migration path

Each stage ships behind `CLAWHUB_SCHEDULER_ENABLED` (default off), fully functional at every step.

- **Stage 0 — Schema (migration 00NN).** Add the nullable columns to `ci_runs`
  (`schema.ts:ciRuns`). Pure additive, no behavior change. The `ci_runs_running_group_uniq`
  partial-unique pattern is the template if we later want a per-node running-count invariant.
- **Stage 1 — Stamp at enqueue (no scheduler yet).** Add `queueRun(row)` and call it from
  `dispatchStandingRun` (all agent modes + system agents) and the 5 CI enqueue sites. Columns
  populated but unused — pure observability; verify the bands look right first.
- **Stage 2 — Node heartbeats.** In `runner/src/index.ts`, write `node_capacity[NODE_ID]` to
  Redis every 5s from the existing `waitForHostHeadroom` signal minus the OCI prod reserve.
  Validate against `docker stats`; nothing consumes it yet.
- **Stage 3 — Scheduler pass (shadow).** Add `services/run-scheduler.ts:schedulerPass()` called
  from `runStandingTick` (drop tick to ~5s). Under `=shadow` it computes + logs the proposed
  `assigned_node` without stamping — compare against actual claims for a day.
- **Stage 4 — Enforce.** `=on`: the pass writes `assigned_node`. Add the `assigned_node ===
  NODE_ID` gate in `subscribeOnce`, order the local claim queue by `effective_priority DESC,
  createdAt ASC`. Null `assigned_node` → today's race (self-healing). CAS untouched.
- **Stage 5 (optional) — Backfill + deploy-preemption.** Ship last; aging alone already
  guarantees anti-starvation, so this is a utilization/latency optimization.

**Seams:** `schema.ts:ciRuns` · `standing-agents.ts:dispatchStandingRun` + the 5 CI enqueue sites
· `runner/src/index.ts` heartbeat + `subscribeOnce` gate · new `services/run-scheduler.ts` from
`standing-agent-scheduler.ts:runStandingTick` · `ci-runner.ts:updateRunFromRunner` CAS **unchanged**.

---

## 8. Failure modes

| Failure | Handling | Derived from |
|---|---|---|
| **Node death mid-job** | Heartbeat expires (TTL ~15s) → scheduler stops placing there. No terminal status → existing `reapStaleRuns` / 2h reaper fails the zombie; re-queue preserves original `createdAt` (keeps accrued age). No new machinery. | ClawHub reaper + Slurm requeue |
| **Scheduler restart** | Scheduler holds no state — every pass recomputes from `ci_runs` + heartbeats. Assigned rows keep being claimed; unstamped rows get stamped next pass; gap falls back to the broadcast race. Aging from persisted `createdAt` survives. | Stateless-controller (k8s recompute-from-desired-state) |
| **Preempted agent re-queue** | The one path (deploy-over-agent) marks the agent `pending` with original `createdAt` preserved (high accrued age → next hole → cannot starve as punishment). Failure/backoff *not* incremented (preemption ≠ failure). CAS de-dups double-dispatch. | Slurm requeue-with-priority; Borg preempt-and-reschedule |
| **Priority inversion** | Structurally prevented: aging monotonically raises a stuck job until it crosses the CI band (`W_max ≈ 40–50 min`); deploy's >200 gap + anti-cascade prevents preemption storms; the reserved agent slot guarantees minimum forward progress under sustained CI. | Slurm age_factor |
| **Stale heartbeat over-advertises** | Even if placed on a stale-optimistic node, the runner's `waitForHostHeadroom` + `cpu_shares` refuses at claim time → run stays pending → next pass re-places. Scheduler advisory; local gate authoritative for host safety. | Defense-in-depth; Mesos decline-and-reoffer |
| **Duplicate assignment** | Atomic `pending→running` CAS — first POST wins, second 409s. `assigned_node` narrows but does not replace it. | Existing CAS |
| **Backfilled job overruns** | The hard 2h reaper timeout is the walltime bound the reservation trusts; a long backfilled job is killed, never allowed to push the reserved deploy's start. | Slurm EASY (hard-timeout-bounded) |
| **Scheduler disabled entirely** | `=off` or null `assigned_node` → degrades to *exactly today's behavior* (local-filter broadcast race). Strictly additive; no state where its unavailability stops jobs. | Graceful degradation |

---

## Appendix — provenance

- **Priority bands (deploy>push>verify>review>develop>scout):** Google Borg priority bands + k8s PriorityClass.
- **Additive aging term (capped):** Slurm multifactor `age_factor` + classic OS priority-aging — the mandatory bounded-wait cure.
- **Filter→Score placement:** k8s kube-scheduler Filter→Score→Bind; Nomad feasibility→ranking.
- **Worst-fit / spread (not bin-pack):** Nomad's spread block, flipped from its bin-pack default because a 2-node box wants to avoid starving a node.
- **Reserved agent slot + OCI prod reserve:** Borg headroom-for-higher-bands + HPC advance-reservation.
- **Depth-1 EASY backfill:** Slurm EASY backfilling, hard-timeout-bounded.
- **No-preemption-except-deploy:** the anti-starvation deep-dive's "queue-jump only; restrict preemption to deploy-over-agent with a large delta and anti-cascade".
- **Pull + advisory-assign + CAS-final-guard:** Mesos offer model inverted, over ClawHub's existing atomic-claim substrate.

Everything lands on the existing spine — one `ci_runs` table, `dispatchStandingRun` as the single
agent enqueue point, the `ci.run.queued` fanout, the pull-runner, and the `pending→running` CAS —
with a stateless ~200-line scheduler pass reading persisted priority/resource columns + Redis
capacity heartbeats, and the runner's existing load gate retained as the last-resort protector of
the co-located prod box.
