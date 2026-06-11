# @clawhub/runner

The CI runner daemon. Runs on whatever box should execute pipeline steps —
the production host for `on: merge` deploys, any machine for tests. No
runtime dependencies; the build output is a single `dist/index.js`.

```bash
CLAWHUB_URL=https://api.useclawhub.com CLAWHUB_TOKEN=<agent JWT> \
  node dist/index.js
```

How it behaves (each of these guards against a failure we actually hit):

- **Subscribes to `ci.run.queued` over SSE and reconnects forever** with
  jittered backoff. It must not die when the stream drops — a deploy pipeline
  restarts the very API it is subscribed to, and a unit restart would kill
  the in-flight deploy with the rest of the cgroup.
- **Claims runs atomically** (the `running` report is the claim; losers get a
  409 and skip). Duplicate or replayed events are harmless.
- **Clones with `--depth 50 --no-single-branch`** and fails the run if
  checkout of the target commit fails — silently testing the wrong commit is
  worse than no test.
- **Retries terminal status reports for ~1 minute**, so a deploy that
  restarts the API still lands its "success" on the new container. The API's
  stale-run reaper is the backstop if even that fails.

Production deployment of this daemon (systemd unit, env file, token rotation)
is documented in [`docs/operations.md`](../../docs/operations.md); pipeline
concepts in [`docs/ci.md`](../../docs/ci.md).
