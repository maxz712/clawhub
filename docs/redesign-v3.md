# ClawHub v3 redesign — identities, roles, agents, workflows, review

Decided direction 2026-07-06. Supersedes `docs/agents-ux.md` (v2) and parts of
the review-overhaul docs wherever they conflict. **This is a UI-first
redesign**: several capabilities below already exist in the backend but never
materialized as product surfaces — inventory in the API is not the product.
Each section states the surface first and the backend delta second.
Contradicting or removing existing behavior is in-bounds; the deterministic
spine (below) is not.

## What survives unchanged (the deterministic spine)

- **Deterministic gating**: risk (`risk-engine.ts`) and merge requirements
  (`merge-policy.ts`) are computed deterministically and enforced by code —
  no LLM ever decides a merge. What v3 changes is WHO may merge (roles, §2),
  not HOW requirements are evaluated.
- **Determinism decides, inference informs**: focus synthesis (the
  deterministic focus floor), risk computation, attestation validation
  (`verification.ts`), trailer parsing — no LLM, no agent required, and they
  stay that way.
- **Custody**: platform keys never enter containers (the LLM gateway), sealed
  secrets, egress containment + SSRF/metadata blocks.
- **D10 economics**: tenant quotas, mandatory Loop budgets, the global cap.

Everything else is open.

## 1. Identities

Humans and agents are one conceptual record: `{handle, displayName, avatar,
bio, kind: human|agent}`.

**Implementation: a projection, not a table merge.** `users` and `agents`
keep their tables (token semantics genuinely differ — agent `token_hash`
rotation vs user `token_version` bump — and the merge gate keys on kind). An
`identities` projection (id, kind, handle, display, avatar) is what the UI
directory, activity, and audit key on (`identity_id`). If a single table is
ever wanted, the projection is the migration path.

Surfaces:
- **Directory / "Humans" tab** — manage your own identity, browse public
  profiles, inspect activity within your visible scope.
- **Common-context visibility** — the directory lists only identities that
  share a repo or org with you (or interacted with a shared public repo).
  Already-public surfaces (trending, leaderboard, marketplace, public-repo
  contributor profiles) stay public. Visibility reuses `repoAccessFor`
  semantics — denied read renders as 404, never a second visibility system.
- **Unified audit** — one trail keyed on `identity_id`. Event visibility
  follows the resource: public repo events are public; private events
  (logins, agent edits) are visible to the identity's owner and org admins.
  Logins are private to the *user*, not the org. GDPR follows the
  `platform_usage` precedent: scrub personal attribution, retain events.
- **LLM actions attribute to agent identities** — the native
  reviewer/verifier are already system agents (`agents.isSystem`); every
  machine action is an auditable identity action with a model badge.

## 2. Roles = access control, nothing else

Generic RBAC. A role is a named permission set + repo scope, assignable to
any identity, human or agent. Replaces v2's `{push, review}` pair
(`access_roles` schema widens; the enforcement choke points stay).

**Permissions (v1 set), grouped by domain:**

| Domain | Permissions |
|---|---|
| Repository | `repo:read`, `repo:write`, `repo:admin` |
| Changes | `change:read`, `change:write`, `change:review`, `change:merge` |
| Issues | `issue:read`, `issue:write` |
| Workflows | `workflow:read`, `workflow:write`, `workflow:trigger` |
| Secrets | `secrets:write`, `secrets:read_metadata` |
| Policy & audit | `policy:write`, `audit:read` |
| Memory | `memory:read`, `memory:write` |
| Ops | `ops:kill` (pause/kill agents) |

Dropped from the original proposal: **`change:bypass_policies`** — nothing
may out-rank the sensitive-path baseline. Emergencies go through repo admin +
an audited policy edit.

**Uniform merge rights (owner decision, 2026-07-06).** No kind carve-out:
`change:merge` grants merging to ANY identity that holds it, at any risk.
The merge gate evaluates per-repo POLICY (required approvals, review basis,
CI, sensitive paths) identically for humans and agents — actor-kind checks
(`mergeActorIsAgent`, agent-only CI strictness, earned autonomy as the agent
path to merge rights) are removed. Supervision becomes a configuration
posture, not a hardcoded rule: default roles hand agents no merge
permission, and default merge policy still requires human review at high
risk and on sensitive paths — but an owner who grants an agent a role with
`change:merge` on a repo whose policy allows it gets full agent-autonomy
merges at any risk, by design. Verified autonomy survives as policy (an
attestation may satisfy a configured review requirement).

**Default roles (seeded, cloneable):**
- **Admin** — all permissions.
- **Developer** — `repo:read/write`, `change:read/write/review`, `issue:*`,
  `workflow:read/trigger`.
- **Reviewer** — `repo:read`, `change:read/review`, `issue:read`,
  `audit:read`. No push, no merge.
- **Auditor** — read-only: `repo:read`, `change:read`, `issue:read`,
  `workflow:read`, `audit:read`, `secrets:read_metadata`.

**Scoping:** owner-scoped roles ({all | selected} of the assigner's repos,
as today) plus org-scoped roles (org admin assigns across org repos).

**Enforcement:** `repoAccessFor` stays the single authority. Every route
declares its required permission in ONE mapping table — no ad-hoc per-route
checks. Roleless identities keep legacy grant behavior during migration.

**Templates untangled:** the legacy `agent_roles`
(capability/mode/trigger/task templates) rename to **Agent Templates**;
"Role" means access control only. DB name + legacy routes stay aliased for
the CLI until a later migration.

## 3. Agent types

Two run modes of one identity kind:

**Wrappers (human-driven).** A lightweight agent identity whose token a
human pastes into a local tool (Claude Code, Copilot CLI, Cursor, a script).
Pushes classify as AGENT pushes for attribution (`openedByAgentId`) with the
sponsoring human recorded per push (`on_behalf_of`: acting identity +
sponsor, the git author-vs-committer pattern); merge requirements come from
repo policy like any other push. Wrappers carry no memory; the developer
holds the context.

**Standing agents.** ClawHub-run background workers.
- **BYO mode**: key referenced from the central vault (`llm_keys`; dropdown +
  inline "Add key" in the create flow). Two execution styles: **CLI mode**
  (harness shells out to claude/codex/gemini/copilot with the tool's default
  model) or **API mode** (harness-driven direct API loop against the key's
  provider).
- **Platform-native mode**: metered through the custody gateway; model picked
  from the curated catalog (GLM, DeepSeek initially). **Model × workflow
  validation**: agentic workflows (dev/verify — the browser loop) require a
  clean tool-caller (GLM tier); DeepSeek is single-shot review only. The
  dropdown filters by the workflow's execution mode so a user can never pin a
  model that breaks the loop.
- **Deterministic harness only — no user-provided images.** ClawHub builds
  the harness at deploy time from the repo's stack; the harness owns dep
  setup, memory lifecycle, and skills/MCP materialization. (BYO images are
  removed from the product; the raw API path dies with them.)
- **Intelligence**: per-agent instructions + skills + MCP configs
  (`agents.intelligence`), mounted by the harness, discoverable in-sandbox.

**Default personal agent (on register).** Registration auto-creates exactly
ONE agent per user — `{handle}-agent` via `deriveUniqueUsername`,
platform-native key source, Developer role scoped to the user's repos —
**dormant**: attached to no workflow, zero runs, zero spend. It unifies with
the existing personal agent (`POST /api/v1/agents/personal` returns it;
`ch init` uses it). It doubles as the user's wrapper identity (paste its
token locally) and is one click from deployment (pick repo + workflow +
cadence). The first platform draw auto-creates the mandatory budget row and
draws tenant quota — D10 unchanged. Memory attaches to its *deployed* runs
only, never to local pushes made with its token.

## 4. Workflows

Presented as first-class **Workflow Runs** — their own tab, timeline, and
history, fully decoupled from CI in the UI. (Under the hood they remain
`ci_runs` rows on the same queue; the decoupling is presentation.)

**Triggers:**
- Git events (push / merge / change.opened), schedules, manual — existing.
- **Thread slash commands**: `/review`, `/test`, `/bump`, … typed in Change
  or Issue threads dispatch the SAME server-side workflow expansion
  (`services/agent-workflows.ts`) — one grammar, two entry points, never a
  second slash system. Authz: the commenter needs `workflow:trigger`.
  Billing: the run draws the REPO's budget; the triggering identity is
  recorded on the run. Injection: commands parse only from the raw comment of
  a permitted identity (never from text an agent echoed); trailing text
  enters the prompt fenced as untrusted operator focus.

**Dedup — coalesce-to-latest, never FIFO.** Leases keyed
`identity:action:resource@version` (version = head SHA for Changes).
Identical pending → dropped. Running at the same version → dropped. Running
at an older version → newest pending wins, older pending collapse to
`skipped`. This generalizes the existing CI concurrency groups +
advisory-review supersede-on-new-head; a queued run about a stale head is
wasted money, so nothing ever "waits in line" behind obsolete work.

**Workflow auditing:** per-run timeline (what it was asked, steps taken,
evidence, verdict, tokens/cost) layered on the identity audit trail.

## 5. Review = one feed

A single page defaulting to the **focused** diff. Two things are removed:
the Evidence/Diff tab split AND the stacked-widget layout (brief card +
advisory card + verification panel piled above the tabs) — that stack is
today's crowding problem. The redesigned page is one feed: a slim status
strip (risk · CI · verification verdict · advisory verdict — one line each,
linking down), then the focused diff with annotations inline, then
discussion.

- The **deterministic focus floor stays** (`focus-synthesis.ts`): every
  Change has flags even with zero agents and zero LLM spend.
- **Inline annotations**: LLM warnings, critical decisions, and advisory
  remarks render above the relevant lines — with **provenance badges**.
  Three visually distinct trust tiers: *deterministic* (focus floor),
  *attested* (server-validated verification runs), *advisory* (LLM opinion).
  Advisory text never renders as authoritative.
- Annotations pin to a head SHA; a new push re-anchors or drops them
  (supersede-on-new-head, existing semantics).
- **Auto-collapse non-flagged files** to header rows; the full diff stays one
  click away (invariant). Expand-all is recorded on the review so a
  `basis: code` approval is honest about what was actually read.
- Evidence (screenshots, verification checks, CI results) inlines in the
  same feed in flow order — no separate widget page.

## 6. Graphify = structural code index (default-on)

Repositioned: **not memory**. A mechanical code graph — files, symbols,
references, hierarchy — built incrementally on default-branch pushes in the
same path as `code-index.ts`; per-repo opt-out. Consumers: agents (the
harness queries it for structure discovery) and the dashboard code browser.
The memory graph (`memory_edges`) keeps its own name; the old in-container
graphify step that fed memory edges folds into `reflect`. Naming rule: the
code index is "Graphify", the memory layer is "memory graph" — never both.

## 7. Memory

- **Packs + writes are standing-agent capabilities.** Wrapper agents get
  neither. The harness owns the lifecycle (retrieve → inject → flush at run
  end); containers never touch SQL.
- **Deterministic repo capture stays** (`memory-capture.ts`: CI failure
  fingerprints, human corrections, rollback reasons — no LLM). Repo-scoped
  memory is not removed; only its *consumers* narrow to standing runs.
- Shared-scope agent writes remain human-approved before they propagate.

## 8. Execution plane

- **Queue**: async jobs on Redis streams + worker nodes — unchanged.
- **Scheduler**: two priority tiers — **interactive/gating** (pushes, PR CI,
  slash-command runs a human is waiting on) and **workflow/standing**
  (scheduled runs, background refactors, reflect) — PLUS per-tenant weighted
  fair share within each tier and aging promotion so the low tier cannot
  starve and one noisy tenant cannot monopolize the high tier. `runs_on`
  arch is a placement filter, orthogonal to priority. (This is the minimal
  core of `docs/job-scheduler-design.md`.)
- **Sandbox policy**: freedom inside the box — npm/pip installs, run the app,
  drive the browser — balanced by an immutable OS (no root mutations except
  harness helper tools), the allowlisting egress proxy (package registries
  allowed; private/loopback/metadata ranges always blocked), and hard safety
  gates (timeouts, billing caps, circuit breaker). **Web search is a
  ClawHub-side tool** the harness proxies through the API — raw egress to
  search engines stays closed, because a search engine is an open door to
  arbitrary URLs and would pierce the allowlist model.

## 9. Removed

- The claim flow + claim tokens (v2 killed anonymous registration; wrappers
  replace claiming end-to-end).
- BYO harness images.
- The Evidence/Diff tab split + the stacked-card layout on the change page.
- Kind-keyed merge gating (`mergeActorIsAgent`, agent-only CI strictness,
  earned autonomy as the agent path to merge rights) — merge access is
  role-based; requirements are uniform per-repo policy.
- The v2 `{push, review}` permission pair (superseded by RBAC).
- "Role" as a template concept (`agent_roles` → Agent Templates).
- Standing-agent surfaces in repo Settings (hub-only — already done in v2).

## 10. Phasing

1. **Identity projection** + unified audit + directory/Humans tab.
2. **RBAC**: permission set, default roles, the route→permission mapping,
   the uniform merge-gate refactor (kind checks out of `merge-policy.ts`) +
   human/agent parity tests.
3. **Agent hub v3**: wrapper/standing sections, default personal agent on
   register, vault dropdown, platform model picker with mode validation,
   Templates rename.
4. **Workflow Runs** UI + thread slash commands + coalesce leases.
5. **Review feed**: inline annotations, provenance badges, auto-collapse.
6. **Graphify index** + scheduler tiers/fair-share.
