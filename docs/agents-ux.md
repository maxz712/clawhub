# Agents UX v2 — identities, access roles, one management surface

Decided 2026-07-05 (v2, superseding the same-day v1 "two-kinds" doc after
owner direction). v1 separated identities from deployments as two management
surfaces; v2 goes further: **agents and humans are the same kind of thing — an
identity** — and everything else (access, keys, where they run) is an
attribute you set from ONE page.

## Principles

1. **Identities all the way down.** Humans and agents both act on ClawHub —
   commit, review, comment — and their actions render IDENTICALLY in the UI
   (same rows, same avatars-and-names, same timeline placement). The only
   visual difference is the bot marker on an agent. The only structural
   difference is governance: every agent is owned and controlled by a human
   (kill switch, incident ops, budgets stay).
2. **Humans create agents. Full stop.** There is no anonymous agent
   self-registration and no claim-token ceremony. You create an agent in the
   dashboard (or via your user token on the API); if it runs on your machine
   (Claude Code, Cursor, a script), you paste its token into that tool once
   and it commits as that identity from then on.
3. **A role is ACCESS, not a template.** Roles are permission profiles on
   ClawHub as a whole — which repos, and what the holder may do there (push,
   review). They are principal-agnostic by design (assignable to agents today;
   the schema carries a principal kind so humans can hold them tomorrow).
   Defaults exist to opt into — `Developer` (push + review, all your repos),
   `Reviewer` (review only, all your repos) — and custom roles give granular
   control (pick repos, pick permissions). No roles yet? The create-agent flow
   walks you into making one first.
4. **Keys are a vault, not a per-agent field.** BYO LLM keys are stored once
   (sealed), named, and referenced — any number of agents can share one key.
   The platform-metered LLM is just another dropdown option.
5. **Where an agent runs is a dropdown, not an architecture.**
   - *You run it* — local tools push with the agent's token. Nothing to
     configure.
   - *ClawHub runs it* — pick a key, point at repos (any set within the
     role's scope; a deployment is not chained to one repo), pick a cadence,
     give instructions. That's all.
6. **No container knobs.** Egress, modes, command overrides, images — gone
   from the UI. Every ClawHub-run agent gets the same safe box: it can pull
   the repo, run the app locally in its sandbox, and commit/push Changes.
   (The server keeps the hardened defaults: reference harness image,
   egress `none`, contained network. Operators can still reach the raw API.)
7. **A loop is one agent with good instructions.** The scout → developer →
   reviewer pipeline is not three deployments; it's one agent whose
   instructions say to do all three, holding a role that permits it.
   Instruction PRESETS (Full loop / Reviewer / Scout / Custom) make that a
   dropdown choice. (The legacy multi-role `installLoop` API remains for
   compatibility; the UI no longer leads with it.)

## The create-agent flow (the whole point)

Name → **Role** (dropdown; defaults offered, custom via "New role…") →
**Runs** (myself / ClawHub) → if ClawHub: **Key** (vault entries + "Platform
(metered)" + "Add key…"), **Repos** (multi-select within role scope),
**Instructions** (preset dropdown + editable text), **Cadence**
(daily / hourly / continuous / on new Changes). Create.

- *Runs myself* → token shown ONCE with copy-paste setup lines.
- *ClawHub runs it* → token never surfaces; the server holds it sealed and
  injects it per run (existing standing-agent plumbing, one row per pointed
  repo under the hood, presented as ONE deployment).

## The one management page

`/agents` lists every identity you govern with its badges — `bot` always;
`runs: local` or `runs: N repos · daily`; role chip; key name — and inline
controls for deployed ones (Run now / Pause / Kill). Sections keep local and
ClawHub-run agents visually distinct but on the SAME page. Claim UI is gone;
Issues left the sidebar's Agents group (it was never an agents concern).

## Enforcement (server)

`agents.access_role_id` → `access_roles {permissions: {push, review},
repo_scope: all|selected, repo_ids}`. An agent holding a role is CONSTRAINED
by it at the existing choke points (`checkPushRights` for git pushes,
`repoAccessFor` for API access): out-of-scope repo or missing permission =
no access. Agents with no role keep legacy behavior (their explicit
collaborator grants). Roles never grant merge rights — the merge gate is
policy, unchanged.

## What deliberately did not change

Merge gates, risk, verified autonomy, memory, the runner/egress hardening
(defaults still apply — just not user-facing), org fleet, incident ops,
kill switches, budgets. The standing-agents API keeps working; the legacy
role-template + loop APIs remain for the CLI and existing deployments.

## Refinements (same day, owner-directed)

- **Human-directed creation is role-only.** Name + role → token. Nothing else.
- **Deployed keys**: BYO is ONE field that takes an API key *or* a Claude
  subscription token (`sk-ant-oat…` — the harness already routes it to
  `CLAUDE_CODE_OAUTH_TOKEN`); platform-metered runs may pin a qualified
  catalog model (GLM-5.2, DeepSeek V4 Flash, …) from a dropdown.
- **Workflows are prompt instructions with slash flags.** `/dev`, `/review`,
  `/verify`, `/scout`, `/triage`, `/loop` expand SERVER-SIDE at dispatch
  (`services/agent-workflows.ts`) — identically for scheduled, triggered, and
  manual runs — and pin the matching harness mode. Trailing text is operator
  focus (`/dev focus on dark mode`). Every run is auditable:
  `GET /api/v1/agents/:id/runs` (surfaced as the Runs card on the agent page)
  lists what each run was asked to do and how it ended.
- **Model intelligence is per-agent**: skills + MCP servers
  (`agents.intelligence`, PATCH `/agents/:id/intelligence`, Intelligence card).
  The harness materializes them deterministically for ANY CLI or API loop —
  skills → `.claude/skills/<name>/SKILL.md`, MCP → `.mcp.json`, and both are
  named in the prompt so non-claude runners know what they have. Never
  committed with the agent's work.
- **The deterministic harness owns repo setup.** Before the agent runs,
  `entrypoint.sh` installs dependencies itself (npm/pnpm/yarn/pip/go, bounded,
  non-fatal) — the agent spends tokens on the task, not on bootstrapping.
- **Repo Settings carries NO agent surface at all.** The Standing-agents tab
  is gone from Settings; deployments (and the Loop installer) live only in
  the hub (`/agents/standing?repo=…`). CI was promoted out of Settings to a
  first-class repo tab (`/repos/:ns/:repo/ci`) — you read runs far more often
  than you edit configuration.
