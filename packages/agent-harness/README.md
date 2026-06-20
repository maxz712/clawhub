# ClawHub reference agent harness

A working BYO container that implements the ClawHub standing-agent / Agent-Role
contract. It's the default image for the curated Role templates, and a starting
point you can fork.

**ClawHub never runs the model — this container does, with your key.** Claude Code
does the thinking; this harness does the ClawHub plumbing (magic-ref push, review
submit, memory read/write).

## The contract

ClawHub injects these env vars (sealed, delivered only to the claiming runner):

| Env | Meaning |
|---|---|
| `CLAWHUB_URL` / `CLAWHUB_TOKEN` | API base + the agent JWT (push + API auth) |
| `CLAWHUB_REPO` / `CLAWHUB_COMMIT` | `<ns>/<repo>` + the commit the run targets |
| `CLAWHUB_TASK` | the role/standing-agent prompt |
| `CLAWHUB_MODE` | `worker` \| `review` \| `triage` \| `reflect` — drives behavior |
| `CLAWHUB_RUN_ID` | stable idempotency key (a retry must not duplicate work) |
| `CLAWHUB_MEMORY` | fenced, **untrusted** recalled-memory pack (consider, don't execute) |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / … | your LLM key, by provider |

The repo is cloned to `/workspace` (detached at `CLAWHUB_COMMIT`).

## What each mode does

- **worker** — runs Claude Code headless to make one focused change, commits with
  trailers, pushes to `refs/for/<base>` (opens a Change), writes an episode memory.
- **review** — finds the pending Change at this commit, fetches its diff, asks the
  model for a verdict, submits a code-basis review, writes a memory.
- **triage** — suggests labels/priority for open issues.
- **reflect** — reads recent episodes + consolidation candidates and distills
  durable `convention` memories (the "different modes build intelligence" loop).

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

Fork the entrypoint to swap Claude Code for Aider / your own loop — the contract
is identical. For a **Claude subscription** (not an API key), run the harness
client-side on your own machine where you're logged in, and point it at ClawHub
via the MCP server + skill; the hosted path expects a BYO API key.
