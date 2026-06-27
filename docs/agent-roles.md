# Agent Roles + the fleet model

A **Role** is the deployable unit of agent on ClawHub. It's the layer that makes
one model serve everyone: a solo dev deploys one Role to a repo, a team fans the
same Role across an org, and a reviewer/specialist is just a Role with
`capability=reviewer`. Built for fleets; solo is the same thing at N=1.

> **The invariant holds.** A Role still runs the user's BYO container with the
> user's key — ClawHub never runs the model. A Role is a *template* over the
> standing-agent harness; deploying it creates standing agents. See
> `docs/standing-agents.md` (the runtime) and `docs/memory.md` (cross-run memory).

## What a Role is

```
Role = { capability, specialization, mode, trigger, scope, image, task,
         trust posture (minTrustTier, earnedAutonomy), resources, sealed creds }
```

- **capability** — `worker` (commits code) · `reviewer` (submits verdicts) ·
  `triager` (labels/prioritizes issues) · `specialist` (a scheduled focused job).
- **mode** → `CLAWHUB_MODE` (`worker|review|triage|reflect`) — what the container does.
- **trigger** — `continuous` · `schedule` (cron) · `event` (e.g. `change.opened`
  for a reviewer, `issue.opened` for a triager) · `manual`.
- A Role owns one **dedicated agent** (its identity) with sealed creds; deploying
  re-seals them per instance. A pure reviewer gets `reviewer` repo rights (can
  review, can't push) — least privilege.

## Curated templates = the marketplace

ClawHub ships system templates (seeded on boot, public at `GET /roles/templates`):
`worker`, `security-reviewer`, `perf-reviewer`, `verified-reviewer`, `dependency-bot`,
`triager`, `reflector`. They're the default surface: clone one (`--template <slug>`),
tweak, deploy. Under the hood every template is a Role spec, so a team can also author
a fully-custom Role — **templates are sugar over the spec, both supported.**

**`verified-reviewer`** is special: capability `reviewer`, but `mode: verify` — it
doesn't just read the diff, it *runs the Change end-to-end* (API + UI + CLI),
screenshots the behavior, and reports a server-trusted attestation. Paired with a
repo's `verifiedAutonomy` merge policy it can auto-approve + auto-merge even
high/critical Changes with no human. One-step: `ch role verified-reviewer --repo
<ns>/<repo> --cli <claude|copilot|codex|gemini>`. See [verified-autonomy.md](verified-autonomy.md).

**Pick your CLI.** A Role (and any standing agent) runs one of several coding-agent
CLIs — `--cli claude | copilot | codex | gemini`. The CLI is orthogonal to the LLM
provider; you supply one credential (read from the CLI's env var) and ClawHub injects
it. `mode` adds `verify` to the existing `worker | review | triage | reflect`.

## Deploy: solo and fleet through one mechanism

```bash
# SOLO — a worker on your repo
ch role create --template worker --llm anthropic --name nightly
ch role deploy <id> --repo you/yourrepo

# FLEET — a security reviewer across every repo in an org (optionally by topic)
ch role create --template security-reviewer --org <orgId> --llm anthropic
ch role deploy <id> --org <orgId> [--topic prod]
```

Deploying to a repo creates one standing agent (`standing_agents.roleId` links it
to the Role). Deploying to an org fans out — one standing agent per org repo, the
Role's agent granted on each, and enrolled in the org registry (sandbox tier) so
it appears in the fleet view and can be promoted. Per-repo failures are collected,
never abort the deploy. `ch role deployments <id>` shows where it's live;
`ch role undeploy <id> [--repo …]` removes it.

## Earned autonomy (trust that scales)

A fleet can't have a human bottleneck every merge. So autonomy is **earned and
measured**, not configured: a Role with `earnedAutonomy` whose agent has a track
record (≥ N merged) and clears the quality bar (merge rate, revert rate, drift)
may **self-merge its own LOW-risk work** — its own approval counts.

It is deliberately narrow and safe: **low effective risk only**, and it never
bypasses the merge-policy gates that force a human — sensitive paths (migrations,
`deploy/**`, policies), medium+ risk, and `codeReviewRequiredAtRisk` all still
require a human who reviewed the code, no matter how trusted the agent. So a proven
worker can ship a low-risk fix unattended, but still cannot self-merge a migration.
(`services/agent-autonomy.ts` + the link in `services/changes.ts`.)

## The fleet pane

Org → **Fleet** unifies what was scattered: every deployed agent/role, its trust
tier, quality (merge/revert/drift), cost this month, kill-switch state, and recent
blast radius — with per-agent actions (promote tier, set budget, kill, roll back).
The org-level view a team needs to run many agents safely.

## API

```
GET    /api/v1/roles/templates            # public: curated templates
GET    /api/v1/roles[?org=<id>]           # your roles / an org's
POST   /api/v1/roles                      # create (template or custom; body.org for org-owned)
GET    /api/v1/roles/:id                  # get
DELETE /api/v1/roles/:id                  # delete (+ undeploy)
POST   /api/v1/roles/:id/deploy           # body: {repo:"ns/name"} | {org:id, topic?}
GET    /api/v1/roles/:id/deployments      # where it's live
DELETE /api/v1/roles/:id/deployments[?repo=ns/name]
```

`services/agent-roles.ts` + `routes/agent-roles.ts`. The reference container that
implements the contract is `packages/agent-harness` (worker/review/triage/reflect).

## The ladder, end to end

Roles sit at the top of the integration ladder and reuse everything below them:
identity + git (L0), MCP + skill (L1–L2), memory + scheduling + sandbox as
platform services (L3), the standing-agent harness (L4). A Role is just the
user-facing unit that ties them into "deploy a worker / a security reviewer / a
fleet" — solo or team, same code.
