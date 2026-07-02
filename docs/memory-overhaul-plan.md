# Memory Overhaul Plan

*2026-07. Produced from a full audit (5-dimension code audit + SOTA research sweep + live
commit/review workflow testing against a local stack and the prod DB/container).*

## Why memory feels useless — the verified diagnosis

Production state at audit time: **4 memory rows total** (all mechanical template episodes,
UUID-laden bodies, `facts={}`, `use_count=0`), **0 rows in `memory_edges`** — against 83
changes and 115 reviews. The system is dead in layers, each sufficient on its own:

1. **Retrieval never worked in production — a driver-level crash.** Every agent-side read
   (`searchMemory`, agent `GET /memory`, and `buildMemoryPack` at standing-run dispatch)
   threw `ERR_INVALID_ARG_TYPE`: drizzle's postgres-js driver cannot serialize a raw `Date`
   inside a `` sql`${col} > ${now}` `` fragment. Reproduced *inside the prod API container*.
   `standingRunEnv` catches the failure best-effort, so every standing run booted with
   **no `CLAWHUB_MEMORY` pack at all**, silently. Fixed (drizzle `gt()`), commit `8c98672`.
   Root process gap: `tests/memory.test.ts` covers only the pure ranking math — zero
   integration coverage on the DB paths, which is how a crash-on-every-call shipped.

2. **The LLM is never asked, told, or equipped to write memory.** No mode prompt
   (worker/develop/review/verify/triage) mentions memory writing, the API, or what is worth
   saving. All writes are the harness's hardcoded `remember episode "Run $RUN_ID: …"`
   templates — UUID noise with empty `facts` (so no derived edges, no fingerprint clusters,
   no path retrieval). `remember()` swallows every failure (`>/dev/null 2>&1 || true`), sent
   `runId` where the API reads `sourceRunId` (idempotency never engaged; fixed in `8c98672`),
   and `POST /memory/batch` (the designed end-of-run flush) has zero callers. The harness
   image also installs the wrong npm package — `@clawhub/cli` is a third-party project;
   ours is `useclawhub` — so `ch memory` was never available in-container (also a
   supply-chain exposure; separate task).

3. **Retrieval is not conditioned on the work.** `standingRunEnv` calls
   `buildMemoryPack(db, ids, {})` — no `changedPaths` — even though `run.commit` (and the
   Change) are in hand at the call site. The path leg and the graph leg
   (`codeEntitiesToMemories` → `expandByGraph`) are therefore dark at dispatch. Live test
   confirmed the pack is a generic importance/recency top-N. Separately, the flat `+10`
   grounded-decision boost dominates the six weighted legs (which sum to ≤ ~4.5), so in the
   live test an unrelated auth *decision* outranked the directly-relevant webhook
   *convention* for a webhook diff.

4. **The pack renders lossily and the loop has no feedback.** `memory_context()` renders
   only `- [kind] title: body` — drops `id`, `facts`, `confidence`, `trust` — so an agent
   cannot cite, bump, fetch, supersede, or link a memory even if prompted. Pack builds use
   `bump: false` and the harness never calls `GET /memory`, so `use_count` stays 0 forever
   and decay's "usage is the survival signal" archives everything on a timer (episodes 21d,
   failures 120d, conventions 240d) regardless of actual usefulness.

5. **The platform's knowledge-bearing moments are never captured.** Human review comments
   and `changes_requested` verdicts, CI failures (structured `stepResults`!), rollbacks
   (which don't even take a `reason`), deploy/incident knowledge, recovered-failure patterns
   — none touch memory. And memory only exists for *standing-agent* runs at all: the bulk of
   real activity (agents pushing Changes from dev machines — e.g. every Claude Code session
   on this repo) has zero memory touchpoints, read or write.

6. **The flywheel mechanisms are unfueled.** Reflect mode is never deployed by default
   (opt-in Reflector role), `consolidationCandidates` clusters only on
   `facts.errorFingerprint` (always empty in practice), reflect writes no server-side
   conventions (only edits `MEMORY.md`), and graphify output never feeds `memory_edges`.
   The graph machinery (`expandByGraph`, derived `about` edges) is live code and works —
   verified in the live test — but had no data to walk.

7. **Zero observability.** Metrics exist (`clawhub_memory_*`) but nothing alerts on
   write-rate zero, retrieval-rate zero, or pack emptiness. Memory was dead for its entire
   life and nothing surfaced it.

**Verdict on architecture:** the mechanical skeleton is genuinely SOTA-shaped — bi-temporal
supersede (Zep/Graphiti's model), scope union, hybrid multi-leg LLM-free ranking (Graphiti
advertises exactly this), decay, quarantine, trust tiers, FIT cognitive/mechanical split.
**Do not replace it with Mem0/Zep/Letta.** The failure is plumbing, write policy, capture
surface, and feedback — not the data model. Graphify is the right tool for *derived code
structure* (Aider-repo-map-class, recompute-don't-remember), but it addresses a different
problem than the one that hurts; the pain is *experiential* memory.

## SOTA lessons applied (research sweep: Mem0, Zep/Graphiti, Letta/MemGPT + sleep-time,
LangMem, A-MEM, ReasoningBank, ExpeL, AWM, Reflexion, Voyager, Claude Code, OpenAI Codex
memory pipeline, Cursor (Memories post-mortem), Devin Knowledge, AGENTS.md, Aider, Cognee)

- **Default to no-op on writes.** Codex's gate: "will a future agent plausibly act better
  because of this?" + an explicit don't-save list. Distilled lessons, never raw logs
  (Reflexion +8%; insight-type memories beat trajectories across coding benchmarks).
- **Outcome-condition everything.** Failures stored *with the guardrail/fix*
  (ReasoningBank), successes as reusable strategies, unverified work stays out (Voyager).
  ClawHub has free ground truth nobody else has: CI status, merge, rollback, review verdicts.
- **In-repo markdown won as the durable tier.** Cursor's server-side auto Memories died;
  AGENTS.md/CLAUDE.md/rules files won. `.clawhub/memory/` is the right durable home;
  server-side `agent_memories` is *working memory* feeding it.
- **Index + bodies-on-demand, hard-capped, with ids and age stamps** (Claude Code 200-line
  index; Codex ~5K-token summary; render age at read time — all mechanical).
- **Read-before-write resolution** (Mem0 ADD/UPDATE/DELETE/NOOP): server supplies near-dup
  candidates mechanically; the agent decides the op. Fits the FIT split exactly.
- **Reflection off the hot path on mechanical triggers** — debounce-until-quiet (LangMem),
  idle/cadence (Letta sleep-time, Codex 6h-idle). Repo-scoped agents are the *best case*
  for sleep-time compute (future queries are about the same codebase). Reflect must
  merge/supersede (rethink), not just append.
- **Usage-reinforcement + citation-based eviction** (Codex: uncited-for-30d falls out;
  LangMem strength leg). Parse which pack entries a run cited — mechanical.
- **Graph pays only for multi-hop** (A-MEM: F1 45.85 vs 25.52 on multi-hop, at much lower
  cost); keep `expandByGraph` as a ranking leg seeded from the diff (Aider's
  personalized-PageRank-from-working-set is the blueprint).
- **Human approval for shared-scope agent-written memory** (Devin suggestion→approve;
  Cursor's approve-before-activate) — a cheap, no-LLM governance upgrade.
- **Evaluate on your own workload; vendor benchmarks are marketing.** Measure steps/tokens/
  success with and without the pack; expect value on complex tasks and pure overhead on
  trivial ones; watch negative transfer from stale/out-of-scope memories.

## The plan

### P0 — Make the loop function (days)
1. ~~Fix the Date-param crash~~ (`8c98672`) — **deploy**; this alone turns packs on in prod.
2. ~~Fix `remember()` `sourceRunId`~~ (`8c98672`) — needs harness image rebuild.
3. Fix Dockerfile `@clawhub/cli` → `useclawhub` (task chip filed; supply-chain + enables
   `ch memory` in-container). Pin and un-`|| true` the install.
4. **Condition the pack on the work**: in `standingRunEnv`, compute changed paths for
   `run.commit`/Change (one `git diff-tree` via GitService) → `buildMemoryPack({changedPaths})`.
   Also export `CLAWHUB_CHANGE_ID`. This lights up the path leg + the whole graph layer.
5. **Enrich mechanical writes with facts**: every `remember()` call passes
   `facts.paths` (`changed_paths_json()` — verify/review modes have the diff in hand),
   `facts.changeId`, verdict/status, and an `errorFingerprint` when CI logs are available.
   Mechanical writes become graph fuel + clusterable instead of noise.
6. **Un-swallow failures + dead-man observability**: `remember()` logs non-2xx into the run
   log; metrics/alerts for writes-per-week=0, retrieval-per-week=0, pack-empty-rate,
   write/read ratio; a Grafana panel.
7. **Ranking sanity + test the DB paths**: replace the flat `+10` decision boost with a
   bounded leg so diff relevance can win; add DB-backed integration tests for
   `searchMemory`/`candidateMemories`/`buildMemoryPack` (the blind spot behind #1).

### P1 — Make the LLM author memory (the content fix; ~1 week)
8. **Write-policy prompt block in every mode** (worker/develop/review/verify/triage):
   no-op-default gate + don't-save list (verbatim Codex/Claude-Code style), the
   ReasoningBank item shape (title / one-line description / distilled lesson **with
   guardrail+fix** for failures), few-shot positive *and negative* examples, kinds +
   importance semantics. Agent emits a JSON list; harness validates and flushes once via
   `POST /memory/batch` (idempotent on `CLAWHUB_RUN_ID`) — the endpoint finally earns its keep.
9. **Render the pack as an index**: id, kind, age-in-days, title, facts.paths, confidence,
   trust — bodies capped; full body via `GET /memory?…` on demand (env creds are inherited
   by the CLI subprocess — verified). Ask the run to **cite memory ids it used**; harness
   parses citations → bump (usage signal + Codex-style eviction input + eval telemetry).
10. **Read-before-write**: batch endpoint returns near-dup candidates (trigram) for each
    incoming item with a `supersedes` suggestion; agent-side NOOP/UPDATE decision next run.
    (Server stays LLM-free.)

### P2 — Capture the platform's knowledge moments (server-side, mechanical, no LLM)
11. **Server auto-episodes with facts** on: `change.rolled_back` (paths + new `reason`
    param), CI failure (normalized `errorFingerprint` from `stepResults`),
    `changes_requested` review (summary + paths), inline comments with suggestions.
    These form the raw layer reflect distills. Templates, not inference.
12. **Ops/deploy knowledge**: self-deploy failures/rollbacks → ops episode in the repo's
    memory (the "production knowledge" the owner misses today).
13. **Capture beyond standing agents**: post-push auto-episode from the Change's `Intent:`
    trailer + diff paths (trailers are already distilled knowledge — free content), so
    repos accrue memory from *all* agent pushes, not just standing runs. Outcome-stamp it
    at merge/rollback.

### P3 — Make the flywheel spin (reflect + durable home)
14. **Reflector on by default** (or one-click at repo setup), triggered by
    debounce-after-quiet rather than fixed cron. Contract: consolidate clusters
    (widen `consolidationCandidates` beyond errorFingerprint: trigram near-dup + shared
    paths), **supersede** stale rows, write server-side conventions *and* distill
    `.clawhub/memory/MEMORY.md`, author edges.
15. **Durable tier = the repo**: keep `.clawhub/memory/` (reviewed like code — the
    industry-winning pattern); harness also reads `AGENTS.md`/`CLAUDE.md` when present
    (compatibility win for imported repos). MEMORY.md capped, index + topic files.
16. **Governance**: pending→approved state for repo/org-scoped agent writes (Devin
    pattern); dashboard Memory tab shows suggestions + memory health (write/read rates).
17. **Graph, earning its keep**: seeded from diff paths (works after P0#4); add mechanical
    co-change edges from git history; keep agent-authored edges but don't depend on them.
    Optional Stage-2: agent-supplied embeddings (columns already exist) + pgvector cosine
    leg — cognition stays in-container, similarity math stays mechanical.

### P4 — Prove it (eval, ongoing)
18. **A/B on our own workload**: replay standing verify/review runs with and without the
    pack; measure steps, tokens, verdict quality, wall-time. Telemetry: pack citation rate,
    pack-empty rate, retrieval-to-write ratio, % memories ever cited. Success criterion:
    memories written per merged Change > 0.5, ≥30% of packs cited, and a measurable step
    reduction on repeat-area tasks. Kill or fix anything the numbers say isn't earning
    its tokens.

## What we explicitly are NOT doing
- Not adopting Mem0/Zep/Letta as a dependency — the no-server-LLM constraint and the
  existing skeleton make ClawHub's design the right shape; the gap was execution.
- Not adding server-side LLM extraction (Cursor Memories' failure mode; violates FIT).
- Not making graphify the experiential store — it stays the derived, always-fresh code map.
