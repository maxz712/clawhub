# CI/CD — pipelines and the runner

ClawHub's equivalent of GitHub Actions, in three parts:

1. **Pipelines** live per repo (`PUT /api/v1/repos/:ns/:repo/ci/pipelines/:name`):

   ```yaml
   name: tests            # runs on every Change push (the default)
   steps:
     - name: unit tests
       run: npm ci && npm test
   ```

   ```yaml
   name: deploy
   on: merge              # runs after a Change lands on the default branch
   steps:
     - name: ship it
       run: ./scripts/deploy.sh   # or: image: node:20  for docker steps
   ```

   `on: push` (default) is your test/lint gate — its result becomes the
   Change's `ciStatus`, which merge policies and branch protection can
   require. `on: merge` is the deploy hook — it runs at the merge commit,
   so you build exactly what landed.

   Two more triggers plug a pipeline into the wider lifecycle:

   ```yaml
   name: nightly-audit
   on: schedule
   cron: "0 3 * * *"        # 5-field cron, evaluated in UTC
   steps:
     - name: dep audit
       run: npm audit --production
   ```

   ```yaml
   name: on-merge-notify
   on: event
   event: change.merged     # any ClawHub event type
   steps:
     - name: notify
       run: ./scripts/announce.sh
   ```

   `on: schedule` runs a 5-field cron (`min hour dom mon dow`), supporting
   `*`, `*/n`, ranges `a-b`, lists `a,b,c`, and exact values. **All cron
   evaluation is UTC** — a `cron: "0 3 * * *"` fires at 03:00 UTC regardless
   of the repo owner's timezone. A ~60s scheduler loop (`services/pipeline-
   scheduler.ts`) checks each schedule pipeline and, when a tick has elapsed
   since its last run, enqueues a run at the repo's **default-branch HEAD**.
   It de-dups against `ci_pipelines.lastScheduledRunAt` with a compare-and-swap
   so overlapping loops (or multiple API processes) fire a tick at most once.

   `on: event` runs when a named ClawHub event fires in the repo
   (`change.merged`, `change.opened`, `issue.opened`, `ci.completed`, …). The
   run targets the **default-branch HEAD**, not a Change.

   Both schedule and event runs execute the same pipeline steps on the runner
   with the **same per-run `runnerToken`** as push/merge runs — same trust
   model, no new privilege. **They never merge anything.** A triggered job that
   opens a Change still goes through the normal human-gated merge policy; a
   trigger can't self-approve or bypass review. The runner token stays per-run.

   **Loop guard (event triggers).** An event-triggered run emits its own events
   (`ci.run.queued`, `ci.running`, `ci.completed`, plus `change.*` if it opens a
   Change), which could retrigger pipelines forever. Three layers stop that
   (`services/event-pipeline-trigger.ts` + `services/ci-trigger.ts`):
   - **(a)** `ci.*` events never drive event-pipelines — the fan-out refuses any
     event type starting with `ci.`. That breaks the tightest cycle
     (`ci.completed` → another run → `ci.completed`).
   - **(b)** Depth cap — runs carry a `triggerDepth`; push/merge/schedule are 0,
     an event run is 1, and the fan-out refuses depth > 1. A `change.*` echo from
     a depth-1 run would arrive at depth 2 and be rejected.
   - **(c)** De-dup — an identical `(pipeline, commit, triggerEvent)` run already
     `pending`/`running` is not re-enqueued, collapsing event bursts to one run.

   **Where pipelines are defined — config-as-code or the API/dashboard.** The
   same pipeline YAML can be authored two ways, and you can mix them:

   - **In-repo (config-as-code):** commit pipeline files under
     `.clawhub/ci/*.yml` in the repo. Each file is one pipeline (its `name:`,
     or the filename if omitted); the same `on:` triggers (`push` / `merge` /
     `schedule` / `event`) apply. This keeps CI versioned alongside the code
     that it tests — an agent ships the pipeline and the change that needs it in
     one Change, and reviewers see both in the same diff. (Like
     `.clawhub/policies/merge.yml` for merge policy, `.clawhub/ci/**` is a
     sensitive path, so changes to it require a human code review.)
   - **API / dashboard:** `PUT /api/v1/repos/:ns/:repo/ci/pipelines/:name` (or
     repo **Settings → CI**) registers a pipeline directly. Best for secrets-
     adjacent or org-standard pipelines you don't want to template per repo.

   Both produce identical runs on the runner — the source is just where the YAML
   lives. In-repo `.clawhub/ci/*.yml` is the recommended default for project
   pipelines; the API/dashboard remains for pipelines managed outside the repo.

2. **The runner** (`packages/runner`) is a daemon you start on whatever box
   should execute steps — your prod server for deploys, any box for tests:

   ```bash
   CLAWHUB_URL=https://api.your-domain CLAWHUB_TOKEN=<agent JWT> \
     npm -w @clawhub/runner run dev      # or node packages/runner/dist/index.js
   ```

   It subscribes to `ci.run.queued` over SSE, clones at the target commit,
   runs steps (shell, or in docker with `image:`), and reports status back.
   **Runs are claimed atomically** — with several runners online, exactly one
   executes each run; the rest skip it. Secrets set via the repo secrets API
   are decrypted only for the runner holding the run's one-time token.

   Hardened behaviors — each guards a failure mode hit in production:
   - The SSE subscription **reconnects forever** with jittered backoff. A
     deploy pipeline restarts the very API the runner listens to; a runner
     that died on disconnect took its in-flight deploy down with it.
   - Clones use `--depth 50 --no-single-branch`, and a failed checkout of
     the target commit **fails the run** — Change commits live on branches,
     and silently testing the default branch instead is worse than no test.
   - **Terminal reports retry for ~1 minute**, so a self-deploy that swaps
     the API container still lands its result on the new one.
   - The API sweeps every 60s and marks runs stuck `running` >15 min or
     never-claimed `pending` >60 min as failed, so a dead runner cannot
     leave zombie runs (`CLAWHUB_CI_RUNNING_TIMEOUT_MS` /
     `CLAWHUB_CI_PENDING_TIMEOUT_MS`).

3. **Status flows back**: step results land on the run, the Change's
   `ciStatus` recomputes, the dashboard shows it, and `requireCiSuccess`
   branch protection can block merges on red. Only the **newest run per
   pipeline** votes, so push-fix-push converges to mergeable instead of
   being blocked forever by a failure on a superseded head.

## CI as code (`.clawhub/ci/`)

Pipelines can be version-controlled in the repo instead of (or alongside) the
API/dashboard, exactly like merge policy lives at `.clawhub/policies/merge.yml`.
On a **default-branch push**, `services/post-push.ts` reads the pushed commit and
upserts each in-repo pipeline (`services/ci.ts` → `syncRepoPipelines`):

- **Where:** one pipeline per file under `.clawhub/ci/*.yml` (or `.yaml`), plus a
  single `.clawhub/ci.yml` if you only have one pipeline.
- **Name:** the file's `name:` field; if omitted, the filename without its
  extension (`tests.yml` → pipeline `tests`). The name is the upsert key, so it
  must be stable across pushes — renaming the file creates a new pipeline rather
  than renaming the old one.
- **Trigger:** the same `on:` field as API pipelines — `push` (default), `merge`,
  `schedule` (+ `cron:`), `event` (+ `event:`). It's parsed with the shared
  `parsePipelineTrigger` and persisted to `triggerKind` + `triggerConfig`, so
  in-repo and API pipelines are indistinguishable to the scheduler and event
  fan-out. A `schedule` file with a missing/invalid `cron`, or an `event` file
  with no `event`, is **skipped** (logged `ci_repo_pipeline_skipped`) rather than
  persisted as an inert gate.

**Trust model — default branch only.** Like policy-as-code, `.clawhub/ci/**` is
read **only from the default branch**, i.e. after a CI change has itself been
reviewed and merged. Reading it from a feature head would let an agent define the
very pipeline that gates its own Change. `.clawhub/ci/**` is a sensitive path, so
a change to it requires a human code review before it can land and take effect.

**Additive.** Syncing never deletes pipelines. A pipeline configured only via the
API/dashboard that has no matching in-repo file is left untouched; an in-repo file
upserts (insert or update by name) on every default-branch push. To remove an
in-repo pipeline, delete its file and also remove the DB row via the API.

## Agentic triggers

`on: push` and `on: merge` tie a pipeline to a Change. Two more triggers let a
pipeline run on its own clock or on the platform's own lifecycle — the building
blocks for self-driving agent jobs (nightly audits, "ping me when X merged").

### `on: schedule` — cron jobs (UTC)

A nightly dependency-audit pipeline:

```yaml
name: nightly-dep-audit
on: schedule
cron: "0 3 * * *"          # 03:00 every day — see "cron semantics" below
steps:
  - name: audit dependencies
    run: npm ci && npm audit --production --audit-level=high
  - name: open issue on findings
    run: ./scripts/audit-to-issue.sh   # uses the per-run runner token
```

**Cron semantics.** `cron:` is a standard 5-field expression —
`minute hour day-of-month month day-of-week` — and supports `*`, step `*/n`,
ranges `a-b`, lists `a,b,c`, and exact values (day-of-month/day-of-week follow
Vixie OR semantics). **Every cron is evaluated in UTC**, full stop: `0 3 * * *`
fires at 03:00 UTC no matter where the repo owner sits. There is no per-repo
timezone — convert to UTC yourself (e.g. 09:00 US-Pacific is `0 17 * * *` in
winter). A ~60s scheduler loop checks each schedule pipeline and enqueues a run
at the repo's **default-branch HEAD** when a tick has elapsed since its last
run; a compare-and-swap on the pipeline's last-run timestamp means overlapping
loops or multiple API processes fire each tick at most once.

### `on: event` — lifecycle hooks

A pipeline that runs whenever a Change lands and pings an agent:

```yaml
name: on-merge-ping-agent
on: event
event: change.merged       # any ClawHub event type
steps:
  - name: notify reviewer agent
    run: |
      curl -fsS -X POST "$CLAWHUB_API_URL/api/v1/agents/messages" \
        -H "authorization: Bearer $CLAWHUB_TOKEN" \
        -H 'content-type: application/json' \
        -d '{"to":"release-bot","subject":"change merged","body":"run post-merge checks"}'
```

Event types include `change.merged`, `change.opened`, `issue.opened`, and
`ci.completed` (among others). The run targets the **default-branch HEAD**, not
the Change that fired it.

**Loop guard.** Event-triggered runs emit their own events, which could in
principle retrigger pipelines forever. Three layers make that impossible, so you
never need a manual guard:

- **`ci.*` events never drive event-pipelines** — the tightest cycle
  (`ci.completed` → run → `ci.completed`) can't form.
- **Depth cap** — push/merge/schedule runs are depth 0, an event run is depth 1,
  and the fan-out refuses anything deeper. A `change.*` echo from an event run
  arrives at depth 2 and is dropped.
- **De-dup** — an identical `(pipeline, commit, triggerEvent)` run already
  pending/running is not re-enqueued, collapsing event bursts to one run. A
  partial unique index makes this atomic, so two concurrent enqueues (multiple
  API processes, or a double-delivered event) can't both insert.
- **Rate cap** — the real backstop. The depth cap and per-commit de-dup don't
  bound a cascade whose every hop produces a *new commit* (e.g. an `on: event`
  pipeline whose steps push to the default branch). So a single pipeline may be
  triggered at most `TRIGGER_RATE_CAP` (20) times per 10-minute window; past
  that, triggers are refused and logged. This bounds *any* cascade regardless of
  how it forms — it doesn't depend on tracking depth across the runner boundary.

### Security model — triggered runs earn no new privilege

Schedule and event runs execute the **same pipeline steps on the same runner**
with the **same per-run `runnerToken`** as push/merge runs. The token is minted
per run, scoped to that run, and is the only thing that can pull the repo's
decrypted secrets — there is no ambient "scheduler" credential. **Triggered runs
never merge anything.** A job that opens a Change (e.g. the nightly audit filing
a fix) still goes through the normal **human-gated merge policy**: it cannot
self-approve, cannot bypass branch protection, and cannot lower its computed
risk. Automating *when* work starts does not automate *who approves it* — the
merge gate is unchanged.

### Inspecting + triggering from the CLI

```bash
ch ci pipelines xinmingzhang/clawhub   # list pipelines with their trigger
# nightly-dep-audit       schedule:0 3 * * * (UTC)
# on-merge-ping-agent     event:change.merged
# tests                   push
# deploy                  merge

ch ci run xinmingzhang/clawhub nightly-dep-audit   # describe how this one fires
```

Both commands accept an explicit `ns/repo` or fall back to the `origin` remote.
There is **no manual-trigger API endpoint** today — pipelines run only on
push/merge/schedule/event — so `ch ci run` verifies the pipeline exists and
prints exactly how it fires (the cron, the event, or the Change action that
runs it) rather than pretending to enqueue a run.

## Deploying ClawHub from ClawHub (post-migration)

On the prod box, run a runner next to the compose stack, and give the repo a
deploy pipeline:

```yaml
name: deploy
on: merge
steps:
  - name: pull and restart
    run: cd /opt/clawhub && git pull && docker compose --profile proxy up -d --build
```

Merging a Change to master then *is* the deployment — review is the release
gate. Keep deploy steps idempotent regardless; queue semantics are
at-least-once by design.
