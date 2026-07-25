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

## Build preconditions

The build also needs a wall-clock budget: the pipelines declare `timeout_sec: 5400`
and BOTH the runner and the server-side stale-run reaper honour it. Without that the
reaper's 15-minute CI default terminated every rebuild at ~940s as `stuck` — a
truncated log with no error, because nothing had failed: the server gave up on a run
that was still building.

The image is ~6GB and its multi-arch build runs on the CI runners, so the build host
needs real headroom. `scripts/self-deploy.sh` reclaims docker space on every deploy
(dangling images + build cache; never `system prune -a`, which would delete the
`:latest` that standing runs pull). Without that the box silently filled and the build
failed with `ResourceExhausted: ... no space left on device` — which reads as a flaky
harness build, because a full disk breaks whatever runs next rather than whatever
filled it. See docs/operations.md.

## What each mode does

- **worker** / **develop** — run the selected CLI headless to make one focused change,
  commit with trailers, push to `refs/for/<base>` (opens a Change), write an episode
  memory. The commit's title + `Intent:`/`Closes:`/`Risk:`/`Review-Focus:` come from a
  fenced `===CLAWHUB_CHANGE===` block the agent emits (JSON `{intent, closes, risk,
  reviewFocus}`, same protocol as the memory fence) — so a Change describes what the
  agent BUILT, even when it self-selected an issue from a broad instruction. If the
  agent emits no block, the harness falls back to a harness-linked issue title, then a
  single capped line of the task (a multi-line workflow instruction never becomes the title).
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
- **reflect** — curates the repo's IN-REPO memory: refreshes the graphify code map
  (`clawhub-graph --persist .clawhub/memory` → `graph.json` + `GRAPH_MAP.md`),
  distills durable conventions into `.clawhub/memory/MEMORY.md`, and opens a Change so
  the update is reviewed like code. Repo memory lives WITH the repo (travels with
  clone/fork/transfer); per-agent memory accrues server-side in the other modes. Every
  mode also reads `.clawhub/memory/` at start (alongside its `CLAWHUB_MEMORY` pack).

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
