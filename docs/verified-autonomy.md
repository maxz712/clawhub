# Verified autonomy — when an agent that *ran the code* can merge it

ClawHub's default posture is supervised: a human owns every merge above low risk, and high/critical risk or sensitive paths require a human who **read the code** ([governance.md](governance.md)). **Verified autonomy** is the one, explicit, per-repo opt-in that lets an *agent* satisfy that gate — but only when ClawHub can attest, deterministically and server-side, that the change was **verified end-to-end**: a deployed reviewer agent booted the app, called the API, drove the UI, ran the CLI, screenshotted the behavior, and reported the outcome.

It rests on the same principle as the rest of ClawHub: **you never trust an agent's say-so.** Risk is computed, not declared; and a "verified" approval is anchored on a ClawHub-owned run record, not on the review payload.

> **This removes the human from the loop.** With no floor configured it can merge `scripts/self-deploy.sh`, `.clawhub/policies/**` (the gate's own config), and `critical`-risk changes. It is OFF by default and must be turned on per repo. Read the whole page before enabling it on anything that deploys to production.

## How "verified" is made non-spoofable

A reviewer agent cannot merge a change just by POSTing `{verdict:"approve"}`. Four things ClawHub controls — not the agent — gate a verified attestation:

1. **ClawHub mints the run.** A verify-mode reviewer is triggered by `change.opened`; ClawHub creates the `ci_runs` row (`origin='agent'`) and **pins its `commit` to the change's exact head**. The agent never fabricates a run.
2. **The report binds to that run.** The agent POSTs to `POST /api/v1/repos/:ns/:repo/changes/:id/verification` with `{ runId, checks }` (authed with the agent JWT). The server re-derives every trust fact (`services/verification.ts:recordVerification`): the run is a ClawHub agent run for this repo, the caller **is** that run's standing agent, it is in `verify` mode, and `run.commit === change.headCommit` (commit read from ClawHub's DB). A failed check makes the whole run a failure — the agent cannot assert success.
3. **It's pinned to the head.** The attestation row is unique on `(changeId, headCommit)`. Any new push moves the head, so `evaluate()` no longer finds a matching success → the attestation is **stale and ignored** until the change is re-verified.
4. **No self-verify.** The verifier agent can never be the change's author (the existing no-self-approval invariant, extended).

The residual trust — the agent honestly reporting what a check observed — is the same trust any CI runner gets when it reports "tests passed", bounded by the sandbox + egress containment, the verbatim-stored screenshot evidence, and (optionally) a path/risk floor.

## The gate

`services/merge-policy.ts:evaluateMerge` grants a verified attestation **one** human-approval credit when, and only when, the policy opts in and the attestation clears every guard:

```ts
verifiedAutonomy: {
  enabled: true,            // OFF unless explicitly true
  maxRisk: "critical",      // the highest effective risk a verified attestation may cover
  allowSensitivePaths: true,// may it also satisfy the sensitive-path human requirement?
  floorGlobs: []            // paths that ALWAYS need a human, even verified (default: none)
}
autoMergeOnVerified: true   // hands-off: auto-merge a verified + mergeable change
```

- The credit is exactly **one** slot — `minApprovalsHuman: 2` still needs the extra humans.
- `floorGlobs` is your backstop. `RECOMMENDED_VERIFIED_AUTONOMY_FLOOR_GLOBS` (`.clawhub/policies/**`, `.clawhub/ci/**`, `scripts/**`, `deploy/**`) is a safe preset — set it to keep the deploy/policy control plane human-only while everything else flows.
- **CI still gates** (`ciRequired`), and `request_changes` from anyone still blocks.

Everything is parsed safe-OFF in `normalizeMergePolicy`: a missing, malformed, or `enabled:false` block means the feature is off.

## Hands-off auto-merge

With `autoMergeOnVerified: true`, ClawHub auto-merges a change the moment it is **verified + CI-green + mergeable**. It's driven from the event bus (`app.ts`) on `review.submitted` / `ci.completed` / `change.verified`, so it fires whichever gate lands last. The enqueue is idempotent (keyed on `(changeId, headCommit)`), and the `MergeWorker` re-evaluates under the repo lock — a change that stopped being mergeable (a new push, a `request_changes`) is a safe no-op.

## Set it up (one step)

Deploy a verified reviewer with your CLI of choice and a single credential:

```bash
# Claude / Copilot / Codex / Gemini — pick one; the credential is read from env.
export ANTHROPIC_API_KEY=...     # or OPENAI_API_KEY (codex), GEMINI_API_KEY (gemini), GITHUB_TOKEN (copilot)
ch role verified-reviewer --repo <ns>/<repo> --cli claude
```

Then turn on the gate for that repo (this is the deliberate, dangerous switch):

```bash
# PATCH the repo merge policy. Use a floor unless you truly want none.
curl -X PATCH https://api.useclawhub.com/api/v1/repos/<ns>/<repo> \
  -H "Authorization: Bearer <user-jwt>" -H 'content-type: application/json' \
  -d '{"mergePolicy":{"verifiedAutonomy":{"enabled":true,"maxRisk":"critical","allowSensitivePaths":true,"floorGlobs":[]},"autoMergeOnVerified":true}}'
```

The reviewer is created with `grantRole: reviewer` (review-only — it cannot push); the verification endpoint's run/commit binding is what authorizes the attestation.

## Telling the verifier how to boot + reach your app

The verifier needs to know how to bring your app up and where to hit it. Declare it in **`.clawhub/verify.yml`** (config-as-code, versioned with the change — the harness reads it from the checked-out workspace; no API config to set):

```yaml
# .clawhub/verify.yml
serve: npm --prefix app run start    # command to start the app (optional)
url: http://localhost:3000           # where to reach it
plan: |                              # optional: what behaviors to check
  Sign up, then confirm the dashboard shows the new repo and the API returns 200.
```

`CLAWHUB_VERIFY_SERVE` / `CLAWHUB_VERIFY_URL` / `CLAWHUB_VERIFY_PLAN` env (settable on the standing agent) override the file when present.

Two supported environments, because the verify container is **network-contained** (an `--internal` Docker network whose only exit is the allowlisting egress proxy; no Docker-in-Docker by design — that containment is the point):

- **Single-process app** → boot it in the sandbox. `serve` starts it; the harness reaches it on `localhost` (bypasses the proxy). Works out of the box under `egressPolicy: none`.
- **Multi-service app** (needs a DB/queue, e.g. ClawHub itself = Postgres+Redis) → **do not** boot it in the sandbox. Point `url` at an already-running, allowlisted deployment/preview and deploy the reviewer with `--egress allowlist --egress-host <that-host>`. The verifier drives the live app over the (contained, allowlisted) network. The four CLIs' own LLM endpoints (anthropic/openai/google/github-copilot) are always reachable as infra, even under `none`.

## The verifier harness

The reference harness (`packages/agent-harness`) runs in `verify` mode: it fetches the change diff, asks the selected CLI to exercise every behavior the diff changes (curl for API, `clawhub-browse` for UI, the repo's own tests/CLI), uploads screenshots via `clawhub-evidence`, and POSTs the structured `checks` to the verification endpoint plus an `approve` review (the attestation supplies the human credit; the approve supplies `minApprovalsTotal`). See [browser-agents.md](browser-agents.md) for the browser hands and [standing-agents.md](standing-agents.md) for the BYO-CLI contract (`CLAWHUB_CLI`).

> **Operational prerequisite.** The `verify` mode + the four CLIs live in the **harness image** (`CLAWHUB_HARNESS_IMAGE`, default `ghcr.io/maxz712/clawhub-agent-harness:latest`). After changing `packages/agent-harness/**` you must republish it (`scripts/build-harness.sh`, wired opt-in into `scripts/self-deploy.sh` via `CLAWHUB_BUILD_HARNESS=1`) — otherwise deployed reviewers pull a stale image without `verify` mode.

## What this does NOT change

- Risk is still computed (`risk-engine.ts`); an agent still can't talk a change below its real risk.
- `BASELINE_SENSITIVE_GLOBS` and the supervised default are untouched — verified autonomy is a *new, opt-in override path*, not a weakening of the default.
- Repos that don't opt in behave exactly as before.

See also: [governance.md](governance.md), [agent-roles.md](agent-roles.md), [../design.md](../design.md).
