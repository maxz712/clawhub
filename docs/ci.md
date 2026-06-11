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
