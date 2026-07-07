# ClawHub v4 — workflows own the work; identities live in one place

Owner-decided direction, 2026-07-06 (same day as v3 shipped — v4 corrects
v3's UX where it still leaned on the old models). **Supersedes v3
(docs/redesign-v3.md) and every older doc where they conflict.** Implemented
with migration 0065.

## The model

- **A DEPLOYMENT (standing agent) is identity + role + LLM provider. Nothing
  else.** No repo, no cadence, no instructions. `standing_agents.repo_id` is
  nullable — null is the default ("global"): the deployment reaches every
  repo its role scope + its owner's governance admit, resolved AT DISPATCH
  TIME. Repo-pinned rows remain for the system reviewer/verifier and legacy
  deployments. Deploy flow: name → role (dropdown or create-new) → provider
  (platform-native with a model select, or BYO with a key dropdown + an
  add-new-key option — never a raw key field in this step).
- **A WORKFLOW is where users tell agents what to do** (`workflows` table):
  instructions (slash flags for the simple cases, natural language for the
  rest), its OWN trigger/schedule (cadence is a workflow-scheduling
  responsibility, not a deployment property), and an optional repo scope
  (default `all` — keep the optionality, never require a repo). Fully
  editable. Each dispatched run stamps `ci_runs.workflow_id`, so clicking a
  workflow shows its activity history.
- **Templates are workflow presets, not a page.** The Templates page is
  gone; the Workflows tab offers template cards (derived from the slash
  workflows — /dev /review /verify /scout /triage /loop); Deploy opens the
  normal workflow-creation UI with the instructions/trigger prefilled.
- **Identities live in ONE place.** `/people/[handle]` is THE identity page
  for humans and agents alike; an agent simply exposes MORE on the same page
  (management panel + run/activity history) when you govern it.
  `/agents/[id]` redirects there. The hub roster links names to the identity
  page.
- **Any identity may belong to an org — agents included** (`agents.org_id`,
  default null = no org). An agent can be the ORG's rather than a person's.
  Incident-ops scope selection is "Personal agents" vs a specific org — not
  an abstract "scope".
- **Agent runs are ACTIVITY, not CI.** Same `ci_runs` abstraction underneath,
  but the UI leads with what a run PRODUCED — the review it submitted, the
  Change it worked — and demotes execution steps to a disclosure. Agent runs
  and CI runs stay visually distinct surfaces (Runs tab vs CI tab).

## The hub (v4 IA)

- **Top-level nav**: People and **Roles** side by side (RBAC management left
  the hub — roles govern humans too).
- **Agents hub tabs**: Overview · **Keys** · **Workflows** · Runs · Memory ·
  Ops (More: Cost, Inbox, Signatures).
  - *Overview* — a lean roster: Wrappers vs Standing; no "deployed by roles"
    grouping; names click through to the identity page.
  - *Keys* — ALL BYO keys are added and managed here (sealed vault; many
    deployments share one key).
  - *Workflows* — the workflow list (edit, enable, run-now, activity
    history) + the template cards.
  - *Ops* — incident ops with the personal-vs-org scope selector.
- **Removed**: Standing-agents tab (deployments are rows on Overview;
  managing them never needed its own tab), Fleet (agents are managed on
  Overview, roles on /roles — the pane was redundant), Sandboxes (users
  cannot bring harness images since v3 — nothing to observe), Templates
  page (folded into Workflows).

## Review page (v4 polish)

- The status strip has NO duplicate information: the Evidence row is gone;
  **Reviews** (reviewer verdicts + attached evidence) and **Scope** (changed
  paths) became their own expandable rows, peers of Risk/CI/Focus/Verify/
  Advisory.
- The CI chip links to the EXACT run that produced the status
  (`/repos/:ns/:repo/ci?run=<id>` scrolls to + highlights it).

## Enforcement notes

- A global deployment gets NO collaborator grants: the agent reaches its
  owner's repos through association (`repoAccessFor`/`checkPushRights` admit
  a claimed agent on its human's namespaces), CEILINGED by its access role.
  Thread slash commands verify the agent holds review+ on the thread's repo
  before dispatching to a global deployment.
- Workflow "all" scope resolves to the owner's governed repos ∩ the role
  scope, newest-active first, fan-out capped
  (`CLAWHUB_WORKFLOW_FANOUT_CAP`, default 5 per tick).
- Uniform merge rights, RBAC, the identities projection, focused review,
  and Graphify are unchanged from v3 (docs/redesign-v3.md §2/§5/§6).

## Deliberately kept

- Per-repo standing rows (system reviewer/verifier, legacy deployments, the
  Loop installer) keep working; the scheduler's embedded-trigger loop only
  serves them. New scheduling goes through workflows.
- `POST /api/v1/agents/managed` accepts legacy `repoIds` (per-repo fan-out)
  for the CLI; without it, deployed = one global row, and any `instructions`
  riding along become the deployment's first workflow.
