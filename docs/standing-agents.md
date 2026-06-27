# Standing agents — bring-your-own-AI, run 24/7

A **standing agent** is an AI you bring (a Claude subscription proxy, an Anthropic
or OpenRouter API key, a locally-hosted model — any agent that speaks to an LLM)
that ClawHub runs continuously, on a schedule, or on repository events, scoped to
one repo, to do real work: open Changes, review Changes, triage issues. It is the
"harness" that turns an LLM key into a teammate.

ClawHub gives the agent its **hands** — a checked-out repo, a scoped push token,
a trigger, a hardened sandbox, and the full governance stack (risk engine, merge
policy, kill switch, cost budget, quotas). You bring the **brain** — the model and
its credentials, which live *inside your container* and are never seen by ClawHub.

> **The invariant holds.** ClawHub still never runs an LLM. A standing agent runs
> *your* container image, which calls *your* model with *your* key. ClawHub
> orchestrates and governs; it does not do inference. And the standing-agent push
> model is unchanged — the standing agent pushes with an **agent** token; every
> push opens a Change that flows through the same human-gated merge policy as any
> other. (Humans can push their own code with a user token, but a standing agent
> is an agent and always pushes as one.)

---

## Mental model

```
                 ┌──────────────────────── ClawHub (the platform) ────────────────────────┐
   you define →  │  standing_agents row: image + trigger + scope + task + sealed creds     │
                 │                                                                          │
   trigger fires │  scheduler / event bus  ──dispatch──▶  ci_runs row (origin='agent')      │
   (cron /       │                                         + ci.run.queued event            │
    interval /   └───────────────────────────────────────────────┬──────────────────────────┘
    event /                                                       │ SSE
    manual)                                                       ▼
                 ┌──────────────────────── Runner (your infra or ClawHub's) ───────────────┐
                 │  claims run · clones repo · pulls sealed env via per-run token           │
                 │                                                                          │
                 │   docker run --network bridge  -e CLAWHUB_TOKEN -e ANTHROPIC_API_KEY ... │
                 │     <your-agent-image>   ◀── inference happens HERE, in your container    │
                 │            │                                                             │
                 │            └─ git push (agent token) ─▶ opens a Change ─▶ governance      │
                 └──────────────────────────────────────────────────────────────────────────┘
```

Nothing here is new infrastructure. A standing agent is a thin abstraction that
**compiles down to the CI run machinery** — the same runner, the same
`ci.run.queued` event, the same per-run-token-gated secrets endpoint, the same
scheduler/event triggers, the same loop guards. The only genuinely new pieces are
(1) the `standing_agents` record, (2) a tick driver, and (3) one runner branch:
run an **image** with **network** instead of no-network shell steps.

---

## Why a harness at all — what ClawHub already had vs. the gap

ClawHub already had every governance and execution primitive an autonomous agent
needs:

| Need | Already in ClawHub |
|------|--------------------|
| Run code in isolation | `services/sandbox.ts` (Docker-exec, hardened) + the CI runner |
| Recurring / event-driven jobs | `on: schedule` (cron) + `on: event` triggers, with loop guards |
| Secret material at rest | `services/secrets.ts` (libsodium seal/unseal) |
| Per-run credential delivery | `GET /api/v1/ci/runs/:id/secrets` (per-run token gated) |
| Bounded blast radius | kill switch, cost budgets, agent quotas, risk engine, merge policy |
| An identity that can push | agent tokens + `repo_collaborators` grants |

What was **missing** was the binding that ties them together into "keep running
*this* agent, as *this* identity, in *this* repo, on *this* cadence, with *these*
credentials" — plus the one runtime capability the no-network CI sandbox lacks:
**network egress to reach an LLM**. Standing agents are exactly that binding.

So the answer to "does ClawHub already do this without a harness?" is: it had all
the parts, but an operator would have had to hand-assemble an `on: schedule`
pipeline, smuggle an LLM key in as a repo secret, and accept that the no-network
sandbox can't call a model. Standing agents make it a first-class, safe, one-command
feature.

---

## Data model

`standing_agents` (one row per attached agent, repo-scoped):

| Column | Meaning |
|--------|---------|
| `repoId` | the repo this agent is scoped to |
| `agentId` | the ClawHub agent identity it acts as (pushes/reviews as) |
| `name` | display name, unique within the repo |
| `image` | **your** container image (the agent harness) |
| `command` | optional command override (else the image ENTRYPOINT) |
| `trigger` | `manual` \| `continuous` \| `schedule` \| `event` |
| `cron` | 5-field UTC cron (schedule trigger) |
| `event` | ClawHub event type, e.g. `change.merged` (event trigger) |
| `intervalSec` | min seconds between ticks (continuous trigger; floor 60) |
| `task` | the prompt/instructions handed to the container as `CLAWHUB_TASK` |
| `llmProvider` | `anthropic` \| `openrouter` \| `openai` \| `custom` |
| `llmBaseUrl` | base URL for a proxy / local model (custom/openrouter) |
| `llmCiphertext` / `llmNonce` | **sealed** LLM API key (libsodium, at rest) |
| `tokenCiphertext` / `tokenNonce` | **sealed** agent JWT the container pushes with |
| `memoryMb` / `cpus` / `timeoutSec` | sandbox resource + wall-clock limits |
| `enabled` | master on/off |
| `status` | `idle` \| `running` \| `paused` \| `error` |
| `lastRunId` / `lastRunAt` / `lastError` | last-run bookkeeping |
| `lastScheduledAt` | cron compare-and-swap marker (schedule trigger) |

A standing run reuses `ci_runs`: `standingAgentId` is set, `pipelineId` is null
(`pipelineId` was made nullable for this), `origin = 'agent'`, `commit` = the
repo's default-branch HEAD. It carries a per-run `runnerToken` exactly like a CI
run — **no new privilege** — and it never merges anything.

Neither sealed secret is ever returned by any API. The agent token and LLM key are
handed to the container **only** through the per-run-token-gated secrets endpoint,
at run time, to the one runner that claimed the run.

---

## Triggers

| Trigger | Fires when | Driven by |
|---------|-----------|-----------|
| `manual` | you call `POST .../run` (or `ch standing run`) | direct dispatch |
| `continuous` | `now - lastRunAt ≥ intervalSec` **and** no run in flight | tick loop (~60s) |
| `schedule` | a 5-field UTC cron tick elapses | tick loop + `cronDue` + CAS claim |
| `event` | a ClawHub event matches `event` | event-bus subscription |

The tick driver (`services/standing-agent-scheduler.ts`) mirrors the CI scheduler:
a `setInterval(~60s).unref()` loop, compare-and-swap on `lastScheduledAt` so
overlapping loops/processes can't double-fire a cron tick, and default-branch-HEAD
targeting with no git spawn on the hot path. Event standing agents subscribe to the
same `EventBus` the CI event triggers use, and `ci.*` events are excluded so an
agent's own run completion can't retrigger it.

### Loop guards (a standing agent that pushes produces events)

Three bounds keep a runaway agent from exhausting the runner fleet or your budget:

1. **One run in flight per agent.** Dispatch refuses if a `pending`/`running`
   `ci_run` already exists for this `standingAgentId`. Continuous + event ticks
   can't stack.
2. **Per-agent rate cap.** At most `STANDING_RATE_CAP` (default 30) runs per agent
   per 10-minute window, counted over `ci_runs`. Bounds *any* loop shape —
   misconfigured tiny interval, event self-trigger, manual spam — with one
   backstop, independent of how the loop forms.
3. **Cost + kill.** Dispatch checks the kill switch (`isAgentKilled`) and the
   agent's cost budget (`checkAgentBudget`) before every tick; either blocks
   dispatch and flips the agent to `error`/`paused`.

These compose with the existing merge-policy gate: even a perfectly-behaved agent
that opens 100 Changes still can't merge a single one above low risk without a
human — the harness grants *zero* merge authority.

## Production robustness

The agent loop is engineered for the failure modes a 24/7 runtime actually hits:

- **Idempotent dispatch — never double-run.** The in-flight check + run insert run
  under a per-agent **Postgres advisory lock** (cluster-wide, so safe across API
  replicas), backstopped by a **partial unique index** on pending standing runs
  (`ci_runs (standing_agent_id) WHERE status='pending'`). Two concurrent ticks
  (overlapping loops, event + continuous, two replicas) can never produce two runs
  for one agent — the loser is treated as already-dispatched.
- **At-least-once delivery — survive a runner outage or API crash.** Dispatch is
  insert-then-publish; the publish is best-effort SSE. Every scheduler tick
  **re-publishes** any standing run still `pending` + unclaimed past a window
  (`CLAWHUB_STANDING_REPUBLISH_AFTER_MS`, default 2m), so a run whose event was
  missed (runner offline) or never sent (API crashed between insert and publish)
  still gets picked up. The runner's **atomic claim** makes re-delivery a no-op, so
  this is exactly-once *effect* on top of at-least-once delivery.
- **Idempotent work — retries don't duplicate.** Each run carries a stable
  `CLAWHUB_RUN_ID`; the contract is to key work on it (branch `agent/$CLAWHUB_RUN_ID`,
  or skip if already pushed) so a re-delivered run doesn't open a second Change.
- **Failure backoff + circuit breaker.** A failed run increments a consecutive-
  failure counter; a continuous agent then waits with **exponential backoff**
  (`intervalSec · 2^n`, capped) instead of hammering every interval and burning
  budget. After `CLAWHUB_STANDING_MAX_FAILURES` (default 5) consecutive failures the
  **circuit breaker auto-pauses** the agent and surfaces the reason to a human. A
  success resets the counter. The reaper feeds the breaker too, so a crashed/timed-
  out run counts as a failure.
- **Zombie-run reaping.** A standing run with no terminal report is reaped after a
  long running-timeout (`CLAWHUB_STANDING_RUNNING_TIMEOUT_MS`, default 2h — far
  longer than a CI run, since agent loops legitimately run long) and counts as a
  failure for the breaker.
- **Observability.** Prometheus counters: `clawhub_standing_dispatch_total{outcome}`
  (queued / in_flight / rate_capped / killed / over_budget / unresolved),
  `clawhub_standing_runs_total{outcome}` (success / failure), and
  `clawhub_standing_runs_republished_total`.

---

## Governance & trust model

A standing agent is **strictly less privileged** than a human operator and exactly
as privileged as any other agent:

- **Pushes open Changes.** The container pushes with the agent token; `post-push`
  parses trailers, enforces the agent's quotas/scopes, computes risk, and opens a
  Change. The agent cannot bypass review.
- **Merges stay human-gated.** `services/merge-policy.ts` is unchanged. Low-risk
  Changes may auto-merge only if the repo has opted into agent auto-merge; medium+
  needs a human; high/critical or sensitive paths need a human who reviewed the
  **code**. The standing agent has no special merge path.
- **Sealed creds, per-run delivery.** The LLM key and the push token are sealed at
  rest and delivered only to the claiming runner over the per-run-token endpoint,
  only while the run is non-terminal.
- **Bounded.** Kill switch, cost budget, quotas, sandbox CPU/memory/timeout, and
  the rate cap all apply. One click on the kill switch stops the agent and reaps
  its running sandboxes.
- **Network is opt-in and scoped to the run.** The CI default is `--network none`.
  A standing run runs with `--network bridge` *only* because it must reach an LLM;
  it is still `--cap-drop=ALL`, `--security-opt no-new-privileges`, memory/CPU
  capped, and wall-clock bounded, with the env-file holding the unsealed creds in a
  per-run `0700` dir (never the mounted workdir, never `docker` argv).
- **Credentials never broadcast.** The `ci.run.queued` event carries the per-run
  token that unlocks a run's secrets, so it is **never** streamed to a user token
  on the SSE bus — only to authorized runner agents (allowlist
  `CLAWHUB_RUNNER_AGENT_IDS`, or repo collaborators). A standing run's secrets are
  delivered only after the run is **claimed** (`status=running`) and contain **only**
  the standing env — the repo's CI secret set is never merged into a network-enabled
  BYO container.
- **Scoped grants.** Attaching a standing agent requires a repo writer / org-admin
  operator (not a plain member), and the acting agent must be one the operator owns
  (a borrowed token can't mint a cross-account repo grant).

---

## The container contract (what your image receives)

When the runner starts your image it sets these environment variables (the
sensitive ones come from the gated secrets endpoint, never the public event):

| Env var | Value |
|---------|-------|
| `CLAWHUB_URL` | the ClawHub base URL |
| `CLAWHUB_TOKEN` | the agent JWT — use it for `git push` and API calls |
| `CLAWHUB_REPO` | `<namespace>/<repo>` |
| `CLAWHUB_COMMIT` | the commit the run targets (default-branch HEAD) |
| `CLAWHUB_TASK` | your `task` prompt/instructions |
| `CLAWHUB_MODE` | `worker` \| `review` \| `verify` \| `triage` \| `reflect` |
| `CLAWHUB_CLI` | which coding-agent CLI to drive: `claude` \| `copilot` \| `codex` \| `gemini` |
| `CLAWHUB_STANDING_AGENT_ID` | this standing agent's id |
| `CLAWHUB_RUN_ID` | this run's id — a **stable idempotency key**; key your work on it so a re-delivered run doesn't duplicate it (e.g. branch `agent/$CLAWHUB_RUN_ID`) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GITHUB_TOKEN` | your single sealed credential, injected under the var the selected `CLAWHUB_CLI` reads (`OPENROUTER_API_KEY` for the openrouter provider) |
| `ANTHROPIC_BASE_URL` / `LLM_BASE_URL` | your `llmBaseUrl`, if set (proxy / local model) |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` | generic mirror, so an image can read one convention |
| *(repo secrets)* | every repo secret is also injected, by name |

The repo is cloned into the working directory and the container runs there
(`-w /workspace`, the clone mounted read-write). A minimal harness image does:

```sh
#!/bin/sh
git config --global user.email "$(git config user.email)"
git checkout -b "agent/$(date +%s)" 2>/dev/null || true
# ... call your model with $CLAWHUB_TASK + the repo, write changes ...
git add -A && git commit -m "Intent: <what>\n\nRisk: low\nAgent: $CLAWHUB_REPO"
git push "$CLAWHUB_URL/$CLAWHUB_REPO.git" HEAD:refs/for/main \
  -c http.extraHeader="Authorization: Basic $(printf 'agent-token:%s' "$CLAWHUB_TOKEN" | base64)"
```

Any agent runtime works — Claude Code headless, Aider, a custom OpenRouter loop,
a local-model client — as long as it reads `CLAWHUB_TASK`, edits the repo, and
pushes to a magic ref with the agent token. ClawHub does the rest.

---

## Usage

### CLI

```bash
# attach a continuous Claude-Code agent to a repo (LLM key read from env, never argv)
export ANTHROPIC_API_KEY=sk-ant-...
ch standing add xinmingzhang/marketsync \
  --name nightly-maintainer \
  --image ghcr.io/me/claude-harness:latest \
  --trigger continuous --interval 3600 \
  --llm anthropic \
  --task "Keep deps current and tests green; open one small Change at a time."

ch standing list xinmingzhang/marketsync
ch standing run   xinmingzhang/marketsync <id>     # fire one tick now
ch standing pause xinmingzhang/marketsync <id>
ch standing logs  xinmingzhang/marketsync <id>     # last run's step output
ch standing rm    xinmingzhang/marketsync <id>
```

By default `ch standing add` uses the agent token already in your CLI config (the
one from `ch init`) — it is sealed server-side so the harness can push as you. Pass
`--llm-key-env VAR` to read the key from a different env var.

### Dashboard

Repo → **Settings → Standing agents**: attach an agent (image, trigger, task,
provider + key), see status/last-run, pause/resume, remove. The key field is
write-only — like repo secrets, it is sealed on submit and never rendered.

### API

```
POST   /api/v1/repos/:ns/:repo/standing-agents      # create (user-auth, repo owner)
GET    /api/v1/repos/:ns/:repo/standing-agents      # list
PATCH  /api/v1/repos/:ns/:repo/standing-agents/:id  # enable/pause/reconfigure
DELETE /api/v1/repos/:ns/:repo/standing-agents/:id  # remove
POST   /api/v1/repos/:ns/:repo/standing-agents/:id/run   # manual tick
```

Create accepts **either** `agentToken` (an existing agent's live JWT — sealed as-is,
no rotation; the CLI path) **or** `agentName` (find-or-create a dedicated agent for
this repo; if it already exists and is claimed to you, its token is rotated and
re-sealed). A dedicated agent per standing worker is recommended, because sealing a
token is the agent's single live token — rotating it elsewhere invalidates the
harness's copy (re-attach to refresh).

---

## Operating a standing-agent runner

The standing-agent runtime *is* the CI runner (`packages/runner`) — it already
subscribes to `ci.run.queued`, claims runs atomically, clones, pulls secrets, and
reports back. The only addition is that when a queued run carries an `image`, the
runner runs that image with `--network bridge` and the injected env instead of
no-network shell steps. So:

- **Self-hosted**: point a `packages/runner` daemon at your instance with Docker
  available. It serves both your CI and your standing agents.
- **Hosted**: the ClawHub operator runs a runner pool. The pool runs *your*
  container with *your* sealed key — the operator still never does inference.

Long agent runs are protected from the stale-run reaper: standing runs get a longer
running-timeout (`CLAWHUB_STANDING_RUNNING_TIMEOUT_MS`, default 2h) than CI runs
(15m), so a legitimately long agent loop isn't reaped mid-flight.

---

## What this is **not**

- It is **not** ClawHub running a model. Your container does that. ClawHub never
  holds a model API connection.
- It is **not** an auto-merge bypass. Every Change a standing agent opens obeys the
  repo's merge policy and risk gates.
- It is **not** unbounded. Kill switch, budget, quotas, rate cap, sandbox limits,
  and per-agent in-flight serialization all apply.

See also: `docs/ci.md` (triggers + runner), `docs/governance.md` (risk + merge
policy), and `CLAUDE.md` → "Standing agents".
