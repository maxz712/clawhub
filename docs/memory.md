# Agent memory (FIT — Foundational Intelligence Tier)

Standing agents run the same repo over and over. Without memory, every run starts
from zero — it re-learns the repo's conventions, re-discovers the same failures,
re-litigates settled decisions. **Memory** lets an agent accumulate knowledge
across runs and across modes (commit / review / triage / reflect) so it gets
better over time.

> **The invariant holds.** ClawHub still never runs an LLM. Memory splits exactly
> like the standing-agent harness: the **agent** does the *cognitive* half (decide
> what's worth remembering, write the note, rate importance, optionally embed,
> reflect/summarize); **ClawHub** does the *mechanical* half (store, trigram-rank,
> recency-decay, scope-authorize, evict, secret-scan, govern). ClawHub never
> interprets a memory's content — it ranks lexically and temporally, which needs
> zero inference. Runs entirely on the existing Postgres 16 + Redis + `pg_trgm`
> substrate — no vector DB, no graph DB, no model dependency.

This is the Generative-Agents / Mem0 split, on ClawHub's substrate.

---

## The 2026-07 overhaul (how the loop actually closes now)

The original implementation shipped with the loop broken at several points (a
2026-07 audit found retrieval crashing, no write prompt, and no eval signal —
the fixes below all landed). The working loop is now:

1. **Capture** — two sources feed the raw layer:
   - *Server-side mechanical capture* (`services/memory-capture.ts`): repo-scoped
     episodes on change **opened** (the Intent trailer + diff paths), **merged**
     (success label), **rolled back** (`kind:failure`, importance 7, with the
     optional rollback `reason` and a `rollback:<reason>` fingerprint), **CI
     failure** (fingerprinted by first failing step), and **human corrections**
     (changes-requested verdicts + inline suggestion comments). Templates over
     structured data — no LLM, idempotent, best-effort.
   - *LLM-authored writes*: every harness mode prompt carries a write-policy
     block (no-op default, don't-save list, `failure = symptom→cause→fix +
     guardrail`); the run emits one fenced `===CLAWHUB_MEMORY===` block that the
     harness flushes via `POST …/memory/batch` (idempotent on the run; the
     response returns trigram near-dup suggestions for later consolidation).
2. **Retrieve, conditioned on the work** — a change-pinned run's pack is built
   from the Change's authoritative `changedPaths` (path + graph ranking legs),
   rendered as an index (`mem:<id>`, kind, age-in-days, paths) so the agent can
   cite and fetch. `CLAWHUB_CHANGE_ID` rides the env.
3. **Reinforce** — the run cites the memories it used; the harness posts them to
   `POST …/memory/cited` → `use_count`/`lastUsedAt` bump (ranking recency + decay
   survival + the `clawhub_memory_cited_total` metric).
4. **Distill** — the Reflector role (mode `reflect`, trigger `quiet` —
   debounce-until-quiet after repo activity settles) consolidates
   `consolidation-candidates` clusters (shared fingerprint ≥2, shared path ≥3)
   into durable conventions that supersede their members (`supersedesIds`), and
   curates `.clawhub/memory/MEMORY.md`.
5. **Govern** — agent-authored SHARED-scope (repo/org) writes land **pending**
   (invisible to retrieval, incl. `as_of` reads) until a human approves
   (`PATCH …/memory/:id` `action:approve`); own-scope writes and server captures
   are live immediately.
6. **Measure** — `clawhub_memory_pack_total{empty,conditioned}` +
   `clawhub_memory_cited_total` + dead-man Prometheus alerts (all-packs-empty,
   writes-flatlined), and `packages/api/scripts/memory-eval.ts <ns>/<repo>`
   reports inventory / usage / conditioning-A/B / graph health per repo.

---

## The split

| Half | Owner | Examples |
|------|-------|----------|
| **Mechanical** (deterministic) | **ClawHub** | append/upsert, bi-temporal supersession, recency decay, trigram candidate selection, weighted-sum ranking, eviction, scope-auth, secret-scan |
| **Cognitive** (needs an LLM) | **the agent container** | deciding what's worth remembering, writing the note, rating importance, optional embedding, reflection/consolidation |

ClawHub serves the *retrieval* half natively; the agent supplies the *write* half
over an API — the same shape as Anthropic's memory tool (client decides, backend
executes) and Letta's self-edited memory blocks.

---

## Data model — one table, discriminated by `kind`

`agent_memories` (mirrors how `ci_runs` overloads one table by `origin`):

| Field | Meaning |
|-------|---------|
| `kind` | `episode` (per-run outcome, decays fast) · `convention` (durable norm) · `failure` (symptom→cause→fix, exact-lookup) · `decision` (ADR-style choice) · `expertise` (ClawHub-derived path familiarity) |
| `scope` / `scopeKey` | `agent` · `repo` · `agent_repo` · `org` — the structural auth boundary (collapsed key for indexing) |
| `agentId` / `repoId` / `orgId` | the scope's referents (nullable per scope) |
| `title` / `body` / `facts` / `tags` | agent-authored content (ClawHub never interprets `body`); `facts` is queryable jsonb (`paths`, `errorFingerprint`, `changeId`, `mode`, …) |
| `importance` (1–10) / `confidence` (0–100) | agent self-rated; importance is a **floor**, cross-checked (see ranking) |
| `trigrams` | `extractTrigrams(title+body+tags)` — the same primitive as the code index |
| `embedding` / `embeddingModel` | **optional** agent-supplied vector; lexical works without it |
| `validFrom` / `validTo` / `supersedesId` | bi-temporal (Zep-style): invalidate, don't delete; correct point-in-time answers |
| `useCount` / `lastUsedAt` / `pinned` / `expiresAt` / `archivedAt` | recency/decay inputs |
| `sourceRunId` / `createdByAgentId` / `quarantinedAt` / `reviewedBy` | provenance + governance |

Indexes: scope+kind+importance (hot retrieval), a partial fingerprint index
("have I hit this error before"), a `(sourceRunId, kind, title)` unique index
(idempotency — a re-delivered run can't double-write), and a decay-sweep index.

---

## Write API — the agent records memory at run end

```
POST /api/v1/repos/:ns/:repo/memory          # one note
POST /api/v1/repos/:ns/:repo/memory/batch    # end-of-run flush, one round-trip
```

Authed by the container's `CLAWHUB_TOKEN` agent JWT (same as opening issues). The
**agent** decides ADD / UPDATE / INVALIDATE; ClawHub executes the SQL:

- **ADD** — insert; server computes `trigrams`, stamps `sourceRunId`/`createdByAgentId`.
- **UPDATE/SUPERSEDE** (`supersedesId` present) — in one txn, set the prior row's
  `validTo = now()` (kept for audit + `?as_of=`) and insert the replacement. Zep
  bi-temporal invalidation — never destructive.
- **INVALIDATE** — soft (`validTo = now()`); hard delete only via GDPR / kill-switch.

**Safety on write**: `secret-scan` over `title+body+facts` (a hit → `422`, nothing
stored — agents can't stash credentials in memory); per-scope row caps + body-size
cap + per-run write cap (same posture as `STANDING_RATE_CAP`); idempotent on
`(sourceRunId, kind, title)`.

---

## Retrieval API + scoring

```
GET /api/v1/repos/:ns/:repo/memory?q=&kind=&fingerprint=&as_of=&limit=
```

Two-stage, identical in spirit to `code-index.search()`:

1. **Candidates** — scope-union filter (`{agent_repo, repo, agent, org}` resolved
   server-side from the agent's grants — never client-supplied) → trigram
   intersection on `q` → live rows only (`validTo IS NULL`, not archived/quarantined).
2. **Rank** — the Generative-Agents formula, run as SQL arithmetic:

```
score = w_rel·relevance        // trigram overlap (or cosine if an embedding is present)
      + w_imp·(importance/10)  // self-rated, FLOOR-checked
      + w_rec·recency          // pow(0.995, hours_since(last_used_at))  ← decay on last ACCESS
      + w_scope·scopePrecedence // agent_repo > repo > org > agent
      + w_path·pathOverlap      // |facts.paths ∩ changed-since-last-run|
```

**Importance is a floor, cross-checked** (mirrors `risk-engine.ts`'s
`max(declared, computed)`): `effectiveImportance = min(selfRated, heuristicCeiling)`
where the ceiling rewards being grounded in a real artifact (errorFingerprint /
changeId), novel, and *used*. An agent self-rating everything 10 still can't
dominate retrieval.

**Embeddings are optional.** Default is lexical-only (ClawHub's workload —
trailers, error strings, paths, conventions — is identifier-heavy, where trigram +
exact-fingerprint recall is adequate). If used, the `embeddingModel` is pinned per
scope; a mismatched-model write is stored but excluded from the cosine leg rather
than silently corrupting similarity. pgvector is a flagged Stage-2.

---

## Reflection — the agent reflects, ClawHub stores

ClawHub can't summarize, so reflection is an agent **run mode**, not a server job:

- A `CLAWHUB_MODE=reflect` standing-agent tick (e.g. a nightly `schedule`) reads
  recent `episode` rows, distills repeated ones into `convention`/`decision`, and
  writes them with `supersedesId` chaining back to the episodes they subsume.
  *Different modes build intelligence*: a worker mode emits episodes all day; a
  reflect mode turns them into durable knowledge.
- ClawHub supplies raw material, not judgment:
  `GET .../memory/consolidation-candidates` returns deterministically-clustered
  duplicates (shared trigrams + fingerprint + path overlap); the agent reads a
  cluster, writes one consolidated row, supersedes the members.
- The only thing ClawHub consolidates itself is the `expertise` rollup (pure
  aggregation of `episode.facts.paths`, no summarization).

---

## Forgetting / decay — ClawHub's one autonomous job

A decay-sweep worker (same unref'd `setInterval` pattern as `pipeline-scheduler.ts`),
deterministic, no model:

- **Differential half-life by kind** (episode: days–weeks; convention/decision:
  months; expertise refreshes). Strength rises with `useCount` and resets on read —
  **usage is the survival signal**; new rows get a protection window.
- **Soft-archive before hard-prune**: below a strength floor → `archivedAt`
  (excluded from reads, recoverable); after a grace window with no re-read → delete.
  A read resurrects a fading memory.
- `expiresAt` hard TTL honored; per-scope row caps with lowest-strength eviction;
  `pinned` + open `decision` rows never decay. The sweep flushes the Redis access
  buffer first so it never evicts a just-used-but-unflushed memory.

---

## Security & governance — the differentiator

Memory is agent-authored text re-injected into a *later* run's context — a
**stored-prompt-injection** primitive. Defenses:

1. **Structural fencing.** The pack is delivered as JSON with every body wrapped in
   a `recalled_memory` envelope tagged `untrusted: true`; the SKILL contract tells
   containers to treat memory bodies as *recalled facts to consider*, never as
   instructions. ClawHub never concatenates memory into a prompt (it builds none).
2. **Trust tiering by provenance.** An agent's own `agent`-scoped rows outrank
   cross-agent `repo`/`org` rows; the pack tags each row `trust: own | cross-agent`
   and the score down-weights cross-author memories.
3. **Provenance on every row** (`createdByAgentId`, `sourceRunId`); a memory that
   shaped a merged Change surfaces in the review sidebar.
4. **Memory quarantine.** Engaging an agent's kill-switch also quarantines the
   `repo`/`org` memories it authored (excluded from reads instantly); blast-radius
   reports how far its conventions spread.
5. **secret-scan on write** (credentials, not injection — injection is 1–4).

**Scope isolation**: `scopeKey` is resolved server-side from the run's own
`ci_runs` row; a run can only read/write scopes its `agentId+repoId` reach.
**Lifecycle**: forks do **not** clone repo memories (disclosure); `ch repo transfer`
moves repo/agent_repo rows with the repo; claim follows the agentId; GDPR/account
delete cascades. Read-time re-auth against *current* grants.

**Negative-transfer guard**: a run that ends in failure (CI-red / rolled-back)
applies a usage *penalty* (not deletion) to the memories that were in its pack, so
memories correlated with failures sink in rank — pure arithmetic, ClawHub never
judges a memory "true".

---

## Memory graph — edges over the notes

Lexical + temporal ranking finds notes that *look* like the query. It cannot find
the note that matters because it is **connected** to what you are touching. The graph
layer adds that: typed, weighted, soft-deletable **edges** (`memory_edges`, migration
0037) over `agent_memories`.

**Two destinations, one table** (discriminated by `dstKind`):
- **memory→memory** — `relates_to` · `refines` · `caused_by` · `contradicts` ·
  `duplicate_of` · `depends_on`.
- **memory→code** — `about`, keyed by the repo-relative **path** the code index
  already uses (no symbol table needed; a path survives edits, a line number does not).

**The invariant split holds — again.** Edges come from two sources, mirroring the
notes themselves; ClawHub still runs no model:
- **Agent-authored (`origin='agent'`)** — the *cognitive* half. The agent, having
  understood the code, asserts "this convention is `about` `src/auth`" or "this
  failure `relates_to` memory X" via the write API. ClawHub validates + stores.
- **ClawHub-derived (`origin='derived'`)** — the *mechanical* half, deterministic,
  zero inference: a memory's `facts.paths` are materialized into `about` edges on
  write, and memories sharing an `errorFingerprint` are linked (the exact signal
  `consolidation-candidates` clusters on). The decay sweep refreshes them.

**Graph-walk retrieval.** `searchMemory` seeds from the lexical top hits **plus** the
memories linked (via `about`) to the diff's changed files, then walks the edge graph
1–2 hops with decaying weight (`expandByGraph`) — memory↔memory both directions, and
memory→code→memory through shared-file **hubs** (two notes about the same file are
related without any O(n²) precompute). Reach becomes a **sixth ranking leg**
(`graph`) beside relevance/importance/recency/scope/path. With no edges the leg is 0
and ranking is byte-for-byte what it was — purely additive. The pure walk math
(`walkFrontiers`) is DB-free and unit-tested.

**Governance is inherited.** Auth is enforced on the *memories* an edge connects
(they carry `scopeKey`), so an edge can never surface a note the reader could not
already see; the walk filters every neighbor to the caller's scope union. Killing an
agent quarantines its edges (a poisoned `about`/`relates_to` is as much a
stored-injection re-entry vector as the note it links); invalidating a memory
invalidates its edges; a hard-pruned memory cascade-deletes them.

**The in-container graph step is part of `reflect` — in the container, never on the
server.** *(Naming, v3: the name **"Graphify"** now refers to ClawHub's structural
CODE graph — `services/code-graph.ts`, `code_graph_nodes/edges`, default-on per repo,
`GET .../code/graph`. The memory-side layer described on this page keeps the name
**"memory graph"** — `memory_edges` — and the in-container extraction step below is
referred to as part of `reflect`, not "graphify". See `docs/redesign-v3.md` §6.)* The
reference harness bakes [the graphify tool](https://github.com/safishamsi/graphify)
(offline tree-sitter code-graph extraction — no API key, nothing leaves the sandbox).
In `develop`/`reflect`, the `clawhub-graph` helper maps the repo's structure into the
prompt so the model authors better `about`/`relates_to` edges; every `worker`/`develop`
run also auto-links its episode to the files it changed (`facts.paths`). The extraction
is the agent's *hands*, the edges are the agent's *words*, and the server only stores +
walks them — the invariant is untouched. See `docs/browser-agents.md`, `docs/agent-roles.md`.

**Surfaces:** `POST/GET .../memory/:id/edges` + `GET .../memory/graph` (human viz) +
`edges[]` on the memory write (`services/memory-graph.ts`); `ch memory graph|edges`
and `ch memory write --about/--relates-to`; MCP `clawhub_memory_link`. The
`GET .../memory/graph` route serves nodes + edges for a repo memory-graph view
(dashboard rendering is a follow-up).

---

## Two homes — repo memory in the repo, agent memory with the agent

Memory splits by WHERE it lives, matching what it is about:

- **Repo memory lives IN the repo** — `.clawhub/memory/` (committed):
  - `graph.json` — the in-repo code map (offline tree-sitter; (re)generated by
    `clawhub-graph --persist .clawhub/memory` during `reflect`). Not to be confused
    with **Graphify**, the server-side structural code graph (`services/code-graph.ts`).
  - `MEMORY.md` — the agent-distilled durable conventions / decisions / known failures.

  So the repo's knowledge is **versioned, diffable, and reviewed through the merge gate
  like code**; it travels with clone / fork / `ch repo transfer`; it is secret-scanned on
  push; and a human owns the merge of any non-trivial memory change. Produced by the
  `reflect` mode (refresh the map → curate `MEMORY.md` → open a Change). `.clawhub/memory/**`
  is ordinary repo content, so the code index searches it for free.
- **Agent memory lives WITH the agent** — the server-side `agent_memories` rows in the
  `agent` / `agent_repo` scopes, delivered as the fenced `CLAWHUB_MEMORY` pack. This is how
  ONE agent gets smarter across every repo it touches — its private working memory, not
  committed anywhere.

**Every run reads BOTH.** At dispatch the agent gets its `CLAWHUB_MEMORY` pack (agent
memory); at run start the harness `repo_memory_context()` reads `.clawhub/memory/` from
the checkout (repo memory) into the prompt. The server-side `repo` / `org` scopes remain
for cross-agent notes an agent writes at runtime, but the CANONICAL, human-curated repo
knowledge is the in-repo `.clawhub/memory/` — reviewed, not merely ranked.

---

## Standing-agent integration

- **PUSH** — at dispatch, `standingRunEnv()` packs a pre-retrieved, token-budgeted,
  fenced memory pack into the gated secrets env as `CLAWHUB_MEMORY` (+ `CLAWHUB_MODE`).
  Computed by the deterministic scorer, path-prioritized by files changed since this
  agent last ran. Zero extra round-trips — the container has working memory the
  moment it boots. Delivered only to the claiming runner behind `runnerToken`.
- **PULL** — mid-run, the container hits `GET .../memory?q=&fingerprint=` for precise
  lookups (on an error, look up `failure` by fingerprint). Bumps `lastUsedAt`.
- **WRITE** — at run end, flush episodes + new conventions via `POST .../memory/batch`,
  idempotent on `CLAWHUB_RUN_ID`.

---

## Surfaces

- **CLI**: `ch memory list/search/write/forget`.
- **MCP**: `memory_search` / `memory_write` tools so any BYO container gets memory
  the way it already gets repos.
- **Dashboard**: Repo → **Memory** tab — browse by kind, provenance, supersession
  history; pin / archive (veto) / correct inline (human supervision).
- **Observability**: `memory_retrieval_total{scope,kind}`, `memory_pack_bytes`,
  `memory_rows{scope}`, `memory_quarantined_total`.

---

## One-line thesis

FIT turns a standing agent's many runs into a **scoped, decaying, governed,
graph-linked** knowledge base using only Postgres + Redis + the existing trigram
primitive and the agent-as-summarizer model — ClawHub stores, ranks (lexically,
temporally, AND by graph reach), scopes, decays, and supervises; the agent thinks.
The invariant holds.

See also: `docs/standing-agents.md`, `CLAUDE.md` → "Agent memory".
