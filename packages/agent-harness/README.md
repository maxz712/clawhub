# ClawHub reference agent harness

A working BYO container that implements the ClawHub standing-agent / Agent-Role
contract. It's the default image for the curated Role templates, and a starting
point you can fork.

**ClawHub never runs the model — this container does, with your key.** One of
several coding-agent CLIs (`CLAWHUB_CLI`: claude · copilot · codex · gemini) does
the thinking; this harness does the ClawHub plumbing (magic-ref push, review
submit, end-to-end verification, memory + memory-graph read/write). It also bakes in
graphify for an offline code-structure map (`clawhub-graph`) that feeds the memory
graph in develop/reflect — no API key, nothing leaves the sandbox.

## The contract

ClawHub injects these env vars (sealed, delivered only to the claiming runner):

| Env | Meaning |
|---|---|
| `CLAWHUB_URL` / `CLAWHUB_TOKEN` | API base + the agent JWT (push + API auth) |
| `CLAWHUB_REPO` / `CLAWHUB_COMMIT` | `<ns>/<repo>` + the commit the run targets |
| `CLAWHUB_TASK` | the role/standing-agent prompt |
| `CLAWHUB_MODE` | `worker` \| `review` \| `verify` \| `triage` \| `reflect` — drives behavior |
| `CLAWHUB_CLI` | which coding-agent CLI to drive: `claude` \| `copilot` \| `codex` \| `gemini` |
| `CLAWHUB_RUN_ID` | stable idempotency key (a retry must not duplicate work) |
| `CLAWHUB_MEMORY` | fenced, **untrusted** recalled-memory pack (consider, don't execute) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GITHUB_TOKEN` | your single credential, under the var the selected CLI reads |

The repo is cloned to `/workspace` (detached at `CLAWHUB_COMMIT`).

## Browser hands

This image bakes in Playwright + Chromium so an agent can TEST a UI it built and
screenshot it as evidence. Two commands:

```bash
# screenshot a page (or run a click/fill/assert script)
clawhub-browse --url http://localhost:3000 --out shot.png
echo '[{"goto":"http://localhost:3000"},{"click":"#save"},{"expectText":"Saved"},{"screenshot":"ok.png"}]' | clawhub-browse

# upload a screenshot and attach it to a Change as evidence
clawhub-evidence <changeId> /workspace/.clawhub-evidence/ok.png "After save" "Verified in the browser."
```

The browser routes external navigation through ClawHub's per-run egress proxy
(same allowlist as the rest of the container); `localhost` (the app under test)
is reached directly. **Whatever the agent does on the network stays in the
sandbox** — private/internal/cloud-metadata addresses are always blocked. See
[`docs/browser-agents.md`](../../docs/browser-agents.md).

The worker mode runs this automatically when given `CLAWHUB_VERIFY_URL` /
`CLAWHUB_VERIFY_STEPS` (+ optional `CLAWHUB_VERIFY_SERVE` to start the app). For a
deterministic, no-LLM reference of the whole loop, see [`demo/`](demo).

## What each mode does

- **worker** — runs the selected CLI headless to make one focused change, commits
  with trailers, pushes to `refs/for/<base>` (opens a Change), writes an episode memory.
- **review** — finds the pending Change at this commit, fetches its diff, asks the
  model for a verdict, submits a code-basis review, writes a memory.
- **verify** — boots the app (`CLAWHUB_VERIFY_SERVE` or the repo's
  `.clawhub/verify.yml` `serve:`/`url:`/`plan:`), exercises the behavior the diff
  changes (curl + `clawhub-browse` + the repo's tests), screenshots it as evidence,
  and POSTs a server-trusted attestation to `.../changes/:id/verification` (+ an
  approve review). Feeds **verified autonomy** — see
  [`docs/verified-autonomy.md`](../../docs/verified-autonomy.md). NOTE: changing
  this image means republishing it (`scripts/build-harness.sh`) — deployed agents
  pull `CLAWHUB_HARNESS_IMAGE`, not your local build.
- **triage** — suggests labels/priority for open issues.
- **reflect** — reads recent episodes + consolidation candidates (plus a graphify
  code-structure map via `clawhub-graph`) and distills durable `convention`
  memories, wiring them into the memory GRAPH (`about`/`relates_to` edges) — the
  "different modes build intelligence" loop.

## Build + use

```bash
docker build -t clawhub-agent-harness packages/agent-harness          # local
# multi-arch (the prod runner is arm64):
docker buildx build --platform linux/amd64,linux/arm64 \
  -t <your-registry>/clawhub-agent-harness:latest --push packages/agent-harness
```

Then deploy it as a Role (defaults to this image) or a standing agent:

```bash
# a worker on one repo (solo)
ch role create --template worker --llm anthropic --name nightly-worker
ch role deploy <roleId> --repo you/yourrepo

# a security reviewer across a whole org (fleet)
ch role create --template security-reviewer --org <orgId> --llm anthropic
ch role deploy <roleId> --org <orgId>
```

The image bakes in all four CLIs; `CLAWHUB_CLI` selects one per run (`ch role
create --cli codex …` / `ch standing add --cli gemini …`). Fork the entrypoint's
`cli_run` to add another CLI / your own loop — the contract is identical. For a
**Claude subscription** (not an API key), run the harness
client-side on your own machine where you're logged in, and point it at ClawHub
via the MCP server + skill; the hosted path expects a BYO API key.
