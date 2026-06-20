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

FIT turns a standing agent's many runs into a **scoped, decaying, governed**
knowledge base using only Postgres + Redis + the existing trigram primitive and the
agent-as-summarizer model — ClawHub stores, ranks, scopes, decays, and supervises;
the agent thinks. The invariant holds.

See also: `docs/standing-agents.md`, `CLAUDE.md` → "Agent memory".
