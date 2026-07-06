# Redesign v3 — implementation plan

Companion to `docs/redesign-v3.md` (the decided direction). This is the build
plan: concrete migrations, services, routes, dashboard files, tests, and
ordering. Migration numbers start at **0060** (current head: 0059). Numbers
below are indicative — renumber to whatever `db:generate` mints, keep the
order.

Conventions that bind every phase:
- Each phase ships **dark** behind a flag and is independently deployable.
- API tests are vitest; DB-touching tests guard behind
  `CLAWHUB_TEST_DATABASE_URL` (`tests/test-db.ts` + `describe.skipIf`).
- Dashboard phases are DONE only after a walked-through live verification
  with before/after screenshots attached to the Change (CLAUDE.md UI/UX
  convention).
- Update CLAUDE.md + the relevant `docs/*.md` in the same Change as the code
  they describe.

---

## P1 — Identity projection, unified audit, directory

**Goal:** one identity concept the UI/audit key on; a People directory with
common-context visibility; no table merge.

### Backend

- **Migration 0060**: `agents.avatar_url`, `agents.bio` (nullable — agents
  currently have no profile fields); `audit_events.actor_handle` (denormalized
  varchar, nullable) so audit rows survive GDPR scrubs with a readable name
  (the `platform_usage` precedent).
- **`services/identities.ts`** (new):
  - `Identity = { id, kind: "human"|"agent", handle, displayName, avatarUrl,
    bio, isSystem?, ownerUserId?, createdAt }` — projected from `users`
    (username/name/avatarUrl/bio) and `agents` (name/new cols;
    `ownerUserId` = `associatedUserId ?? createdByUserId`).
  - `identityByHandle(db, handle)` — resolution order users → agents,
    mirroring `namespace.ts:resolveNamespace` (a user always beats a
    same-named agent).
  - `listVisibleIdentities(db, callerUserId, {q, cursor})` — **common
    context**: identities that are owners/collaborators/members of, or have
    authored activity (changes/reviews/comments) in, repos the caller can
    read. Reuses `repoAccessFor` semantics; a non-shared identity is a 404,
    never "exists but hidden".
- **`services/audit.ts`**: `AuditInput` gains optional `actorHandle`
  (resolve-once at call sites via a small helper); coverage sweep — add
  `record()` calls where they're missing today: agent create/edit/archive,
  role create/assign, llm-key add/delete, workflow trigger, login success
  (auth category exists, event doesn't).
- **`routes/identities.ts`** (new, user token):
  - `GET /api/v1/identities?q=` — directory (common-context scoped).
  - `GET /api/v1/identities/:handle` — profile: identity + shared-context
    summary (repos in common, role badges, agent stats).
  - `GET /api/v1/identities/:handle/activity` — public events from repos the
    caller can read (backed by `public_activity` + `audit_events` public
    categories).
- **GDPR**: `gdpr/export` includes the identity projection + the caller's
  audit rows; delete scrubs `actor_id` (SET NULL) keeping `actor_handle`
  cleared, events retained.

### Dashboard

- Nav: add **People** to `CORE_GROUPS` in `components/nav-sidebar.tsx`.
- `app/(app)/people/page.tsx` — directory (search, avatar, kind/bot badge,
  shared-context line); `app/(app)/people/[handle]/page.tsx` — profile +
  activity. The public `/u/[name]` page stays the unauthenticated shape.
- **Directory ≠ credential management** (original bullet #1): identity
  profile edits (display name, avatar, bio) live on your People profile;
  account credentials (email, password, 2FA, API tokens) stay in
  `/settings`. Two deliberately separate surfaces.
- **`components/identity-chip.tsx`** (new) — the ONE avatar+name+bot-badge
  renderer. Sweep change rows, review cards, comment threads, audit page to
  use it (this is the "humans and agents render identically" payoff).
- Repo audit page: identity chips + actor filter.

### Tests

Resolution order (user beats same-named agent); common-context 404;
directory excludes non-shared identities; GDPR scrub keeps events, clears
attribution.

**Flag:** `CLAWHUB_IDENTITY_DIRECTORY` (routes 404 when off). **Size: M.**

---

## P2 — RBAC (permissions, default roles, enforcement mapping)

**Goal:** roles become generic permission sets assignable to any identity;
`{push, review}` retired; the merge gate made uniform — kind checks removed,
human/agent parity proven by tests.

### Backend

- **Migration 0061**:
  - `access_roles.permissions` becomes a **string array** of permission keys
    (jsonb). Read-compat shim in `access-roles.ts`: legacy `{push, review}`
    objects translate on read (`push→[repo:write, change:write]`,
    `review→[change:review, change:read]` + implied `repo:read`); writes
    store the new shape. One-off data migration UPDATE converts existing
    rows; shim stays one release then dies.
  - `access_roles.owner_org_id` (nullable, XOR `owner_user_id`) — org-scoped
    roles, org-admin managed.
  - **`role_assignments`** table: `{id, role_id FK, identity_kind
    human|agent, identity_id, assigned_by_user_id, created_at}`, unique on
    `(role_id, identity_kind, identity_id)`. Humans can now hold roles.
    Backfill: every `agents.access_role_id` → an assignment row;
    `agents.access_role_id` becomes a legacy-read fallback, dropped later.
- **`services/permissions.ts`** (new):
  - `PERMISSIONS` catalog — the v1 set from redesign-v3 §2 (repo:read/write/
    admin, change:read/write/review/merge, issue:read/write,
    workflow:read/write/trigger, secrets:write/read_metadata, policy:write,
    audit:read, memory:read/write, ops:kill), grouped by domain for the UI.
  - `DEFAULT_ROLES` — Admin / Developer / Reviewer / Auditor definitions;
    seeding migrates the current builtin Developer/Reviewer to the new
    permission arrays and adds Admin + Auditor.
  - `hasPermission(assignments, perm, repoId)` + the **route→permission
    mapping table** (`ROUTE_PERMISSIONS`) — one place, no ad-hoc checks.
- **Enforcement** (the two existing choke points, extended):
  - `repo-access.ts:repoAccessFor` derives `RepoAccessLevel` from permission
    sets (`repo:admin→admin`, `repo:write→write`, `change:review→review`,
    `repo:read→read`) for BOTH kinds; roleless identities keep legacy grant
    behavior (unchanged fallback).
  - `checkPushRights` requires `repo:write`.
  - New `requirePermission(c, perm)` middleware helper for the routes whose
    permission isn't expressible as a repo level (`workflow:trigger`,
    `secrets:*`, `policy:write`, `audit:read`, `ops:kill`).
- **Uniform merge gate (owner decision)** — remove actor-kind checks from
  the merge path:
  - `changes.ts` merge route requires `change:merge` for EVERY actor (humans
    map it from write+ access or a role; agents from a role). An agent
    holding it merges at any risk once policy is satisfied.
  - `merge-policy.ts`: drop `mergeActorIsAgent` and
    `allowAgentMergeWithoutCi`; one uniform CI pair for all actors
    (`ciRequired` — green required, default true — plus a `requireCiRun`
    knob for whether `skipped` counts, default it does).
  - `requireHumanApproval` / `codeReviewRequiredAtRisk` / sensitive-path
    forcing stay in policy with CONSERVATIVE DEFAULTS but become fully
    editable — `BASELINE_SENSITIVE_GLOBS` demotes from non-removable floor
    to default policy content.
  - Earned autonomy (`services/agent-autonomy.ts`) retires as a
    merge-rights mechanism — roles supersede it; verified autonomy stays as
    policy (an attestation satisfies a configured review slot).
- **Templates rename**: `routes/agent-roles.ts` mounts additionally at
  `/api/v1/templates` (alias); response copy says "template". DB rename
  deferred indefinitely (alias is enough).

### Dashboard

- `app/(app)/agents/roles/page.tsx` split: **Roles** = RBAC editor
  (permission checkboxes grouped by domain, repo scope, org scope select,
  clone-a-default) — rework `components/custom-role-dialog.tsx` into the
  full picker. **Templates** move to their own hub tab
  (`app/(app)/agents/templates/page.tsx`) with the deploy flow.
- `components/new-agent-dialog.tsx` role step consumes the new shape.
- Role assignment UI on People profiles (P1) and agent detail pages.

### Tests

Ceiling enforcement at both choke points; legacy-shape compat; org-scoped
assignment authz; the **uniform-gate parity suite**: an agent holding
`change:merge` merges a HIGH-risk diff once policy is satisfied; any
identity without it gets 403; the same policy fixture evaluates identically
for a human and an agent actor (parameterized over actor kind — this suite
is the phase's acceptance gate).

**Flag:** none needed (compat shim IS the migration path). **Size: L.**

---

## P3 — Agent hub v3: default agent, wrappers, platform picker, removals

**Goal:** every user has one dormant platform-keyed agent; wrapper vs
standing presented as run modes; model×mode validated; claim flow and BYO
images removed.

### Backend

- **Default personal agent**:
  - `services/personal-agent.ts` (extract from `routes/agents.ts:173`):
    `ensurePersonalAgent(db, userId)` — find-or-create `{handle}-agent`
    (via `deriveUniqueUsername` against the global agent namespace),
    `isPersonal: true`, Developer role assignment (P2), **no standing rows,
    no runs, no spend** — dormant.
  - Hooks: `routes/users.ts:41` (register) and
    `services/oauth-identity.ts:55` (OAuth first-login) call it
    fire-and-forget (non-fatal); SSO user-creation path likewise. Existing
    users: lazy via `POST /agents/personal` (which now delegates to the same
    function) + hub page load.
  - Deploy default: when a deployed agent picks no vault key, `keySource`
    defaults to `platform` — the existing D10 gates (quota reserve, budget
    row auto-create, global cap) apply untouched.
- **Migration 0062**: `changes.on_behalf_of_user_id` (FK users, SET NULL) +
  `standing_agents.exec_style` (`cli|api`, default `cli`).
- **on_behalf_of**: in `post-push.ts`, when the `PushActor` is an agent,
  stamp sponsor = `agents.associatedUserId ?? createdByUserId` on the Change
  upsert; render in audit metadata. (Per-push sponsor == the agent's owning
  human; good enough until multi-human wrapper sharing exists.)
- **Model × mode validation**: `llm-catalog.ts` entries gain
  `agentic: boolean` (GLM-5.2 true, DeepSeek V4 Flash false, qwen3-coder
  true); `POST /agents/managed` + standing-agent create/update reject 400
  `model_not_agentic` when the workflow's mode is agentic (develop / verify /
  worker-loop) and the pinned model isn't. `GET /llm-catalog` exposes the
  flag so the UI can filter.
- **BYO API mode**: `exec_style='api'` threads to the harness as
  `CLAWHUB_EXEC_STYLE`; the harness API-loop driver itself lands in the next
  **harness image batch** (entrypoint work + multi-arch rebuild — its own
  deploy motion). API accepts + stores the field now; UI hides it until the
  image ships.
- **Removals**:
  - Claim flow: delete `POST /agents/claim` + claim-token rotate; CLI
    `ch claim` removed; `agents.claim_token*` columns orphaned now, dropped
    in a later cleanup migration. Test suites that used claim migrate to
    user-token creation.
  - BYO images: `createStandingAgent`/`updateStandingAgent` reject
    caller-supplied `image`/`command` (400) — the server always stamps
    `CLAWHUB_HARNESS_IMAGE`. Existing rows with custom images keep working
    until touched (log a deprecation counter to find them).

### Dashboard

- Hub overview (`agents/page.tsx`): two sections — **Wrappers** (local; the
  default agent surfaces here with "yours, dormant — set it up locally or
  deploy it") and **Standing** (deployed; per-row status/controls as today).
  One-click deploy prefills `new-agent-dialog`'s deployed path with the
  default agent.
- Platform model picker in `new-agent-dialog.tsx` filters by workflow mode
  using the `agentic` flag.
- Remove any residual claim UI/copy.

### Tests

Register → dormant agent exists (zero `standing_agents`/`ci_runs` rows);
`/agents/personal` returns the same identity; model×mode 400; image field
rejection; on_behalf_of stamped for wrapper pushes and absent for human
pushes.

**Flag:** `CLAWHUB_DEFAULT_PERSONAL_AGENT` (hook no-ops when off).
**Size: M–L.**

---

## P4 — Workflow Runs surface, thread slash commands, coalesce leases

**Goal:** agent runs decoupled from CI in the UI; `/review`-style triggers in
threads; dedup that coalesces to the newest head instead of queueing stale
work.

### Backend

- **Coalesce leases — reuse concurrency groups, don't build new
  infrastructure.** Agent-origin dispatches (standing scheduler, native
  reviewer/verifier, slash triggers) set
  `ci_runs.concurrencyGroup = agent:<agentId>:<mode>:<resource>` (resource =
  changeId for change-pinned runs, repoId otherwise). The existing
  `ci_runs_running_group_uniq` index + `dispatchNextInGroup` (newest pending
  wins, older collapse to `skipped`) already give active-serialization +
  pending-coalescing. Add the missing piece in `dispatchStandingRun`:
  **same-version dedup** — skip enqueue when a pending/running run exists
  for the same `(group, commit)`. Net new code is small; write it in
  `services/run-leases.ts` as a thin helper both dispatch sites call.
- **Migration 0063**: `ci_runs.triggered_by_user_id` (FK users, SET NULL) —
  who asked (slash commands, Run-now clicks).
- **Thread slash commands**:
  - `services/slash-commands.ts` (new): `parseSlashCommand(body)` — a
    LEADING `/cmd` only, matched against `SLASH_WORKFLOWS` keys + aliases
    (`/test → /verify`); trailing text captured as operator focus. Comments
    are stored verbatim regardless of parse outcome.
  - Hooks: `routes/comments.ts` POST (Change threads) +
    `routes/issues.ts` POST comments. After store: commenter must hold
    `workflow:trigger` (P2) — otherwise the comment is just a comment, no
    error, no dispatch (prevents parse-based probing). Target resolution:
    the repo's enabled standing agent whose workflow matches the mode →
    else the commenter's personal agent (platform-gated by D10) → else a
    reply comment explaining nothing is deployed.
  - Dispatch: `dispatchStandingRun` pinned to the Change head
    (`{commit, changeId}`) or issue (`dispatchIssue`); task =
    `expandWorkflowTask()` output with trailing text **fenced as untrusted
    operator focus** (the `CLAWHUB_MEMORY` fencing pattern). Billing draws
    the repo's tenant budget; `triggered_by_user_id` + an audit event
    (`workflow.triggered`) record who.
- **Workflow Runs API**:
  - `GET /api/v1/repos/:ns/:repo/workflow-runs` — `ci_runs` where
    `origin='agent'`, joined with agent identity, workflow/mode, dispatch
    task, cost (sum of `platform_usage` for the run), evidence links.
  - `GET /api/v1/workflow-runs` — cross-repo for the caller's governed repos
    (the `routes/agent-aggregates.ts` pattern).
  - Run detail composes the timeline from existing data: dispatched →
    claimed → `stepResults` → evidence/verification/review produced →
    terminal + cost. No new event table in v1.

### Dashboard

- Repo tab **Runs** (`app/(app)/repos/[ns]/[repo]/workflow-runs/page.tsx`),
  peer of CI in the repo layout tab row; hub tab **Runs**
  (`app/(app)/agents/runs/page.tsx`) for the cross-repo view. Run detail
  drawer: timeline, task, evidence thumbnails, verdict, cost.
- Comment boxes (Change + Issue): slash autocomplete for the available
  workflows; after a dispatch, render the "run started" affordance linking
  to the run.

### Tests

Parse (leading-only, alias, focus text); permissionless commenter → stored
comment, no dispatch; coalesce (newer head collapses pending; same head
dedupes; running old head + new push → newest wins on terminal); billing
attribution row; loop guard (an agent's own comment can't trigger — check
`authorKind`).

**Flag:** `CLAWHUB_SLASH_COMMANDS`. **Size: M.**

---

## P5 — Focused review redesign (one feed, inline annotations, auto-collapse)

**Goal:** a full redesign of the change page around focused review — kill
the Evidence/Diff tab split AND the stacked-card layout (the current
crowding); the diff opens in focused mode; annotations render above the
lines they're about, with provenance; unflagged files collapse.

### Backend (small)

- **Migration 0064**: `reviews.viewed_full_diff` (boolean, default false) —
  the ReviewMergePanel submits whether the reviewer expanded everything; an
  honest `basis: code`.
- No new annotation endpoint: the dashboard already loads everything —
  `reviewBrief` (deterministic), `reviews.contract.additionalFocus`
  (advisory, `{path, startLine, endLine, reason}` + model badge),
  verification checks (attested), diff focus union (source-tagged). Compose
  client-side.

### Dashboard (the bulk)

- `app/(app)/repos/[ns]/[repo]/changes/[id]/page.tsx`: full restructure.
  The `Tabs evidence|diff` model AND the stacked cards (`ReviewBriefCard`,
  `AdvisoryReviewCard`, `VerificationPanel`, `EvidencePanel`) go away as
  standalone widgets. One feed: description → a compact **status strip**
  (risk + CI + verification verdict + advisory verdict, one line each,
  linking down) → **the diff, opening in FOCUSED mode** with inline
  annotations → discussion. Card content redistributes: CI/risk/verdicts
  into the strip, per-line findings into inline annotations, reviewer
  verdicts stay in the sidebar, screenshots/evidence inline in the feed.
- `components/diff-review.tsx`: add `renderLineAnnotations(path, line)`
  (sibling of the existing `renderLineComments`) rendering annotation rows
  ABOVE flagged lines. Annotation = `{source: "deterministic" | "attested" |
  "advisory", text, badge}` with three visually distinct treatments —
  advisory NEVER renders in the attested style (trust-tier laundering is the
  failure mode to test for in review).
- **Auto-collapse**: files with zero annotations render as header rows
  (extend the existing >500-LOC collapse mechanism); "Expand all" expands +
  flips the `viewedFullDiff` payload on the review form. Full-diff toggle
  stays (invariant: one click away).
- Annotations pin to the head SHA they were produced for; on a stale head
  they drop to a "superseded" strip rather than mis-anchoring (advisory
  supersede semantics already exist server-side).

### Verification

Walked-through live flow (the CLAUDE.md convention): a Change with derived
focus + an advisory review + a verification run renders one feed; collapsed
files expand; screenshots attached before/after.

**Flag:** dashboard-side `NEXT_PUBLIC_REVIEW_FEED` (old layout behind it for
one release). **Size: M, UI-heavy.**

---

## P6 — Graphify code index + scheduler tiers

**Goal:** a default-on structural code graph per repo; two-tier scheduling
with tenant fairness.

### Code graph

- **Migration 0065**: `repositories.graphify_enabled` (boolean, default
  true) + `code_graph_nodes` `{id, repo_id, path, symbol, kind
  (function|class|type|const|route), line, commit_sha}` +
  `code_graph_edges` `{id, repo_id, src_node_id, dst_path, dst_symbol,
  kind (imports|references), line}`.
- **`services/code-graph.ts`** (new): dependency-free extraction in the
  `code-index.ts` style — per-language regex def/import extractors (TS/JS,
  Python, Go v1), batched reads via `git.filesAt`, incremental via
  `sinceCommit` diff exactly like `indexRepoAtCommit`; wired best-effort in
  `post-push.ts` next to the code-index call. Kill switch
  `CLAWHUB_DISABLE_CODE_GRAPH=1`.
- API: `GET /api/v1/repos/:ns/:repo/code/graph?symbol=&path=` (read access).
  Harness: `clawhub-code-graph` query CLI in the next harness batch; the
  old in-container memory-graphify step folds into `reflect` (rename only —
  the memory graph keeps `memory_edges` and its name).
- Dashboard: symbol pane in the code browser (defer if thin; the primary
  consumer is agents).

### Scheduler

`ci_runs` already carries the groundwork columns (`priorityClass`,
`effectivePriority`, `resourceRequest`, `runsOn`, `lastHeartbeatAt`) — this
phase makes them live (the minimal core of `docs/job-scheduler-design.md`):

- **Tier stamping** at the three enqueue sites: `priorityClass 0`
  (interactive/gating: origin push/merge + slash-triggered runs) vs `1`
  (standing: schedule/event/agent cadence).
- **Claim ordering** in the runner-claim query: `ORDER BY priorityClass,
  effectivePriority DESC, createdAt` — `runs_on` stays a filter.
- **Aging**: the reaper cadence bumps `effectivePriority` on pending runs
  older than N minutes (low tier can't starve).
- **Tenant fair share**: Redis counter of running runs per tenant; under
  contention the claim skips tenants at their concurrent cap
  (`CLAWHUB_TENANT_MAX_CONCURRENT_RUNS`, default generous). Weighted shares
  can wait.

### Tests

Graph extraction goldens per language; incremental correctness (rename +
delete paths); tier ordering; aging promotion; tenant cap under contention.

**Size: M+M, fully parallelizable with P4/P5.**

---

## Cross-cutting

### Dependency order

```
P1 (identity projection) ──► P2 (RBAC needs role_assignments on identities)
                              └──► P3 (default agent needs Developer role)
P4, P5, P6 — independent of each other; P4 needs P2's workflow:trigger.
```

Suggested sequence: **P1 → P2 → P3**, then **P4 + P5 in parallel**, then
**P6** (or P6's scheduler half any time — it touches nothing the others do).

### Harness image batch (grouped — one rebuild + multi-arch republish)

API-mode loop driver (P3), `clawhub-code-graph` (P6), graphify-step rename
(P6). Batched because the harness image is its own build/deploy motion
(build-harness CI matrix).

### Migration ledger (indicative)

| # | Contents |
|---|---|
| 0060 | `agents.avatar_url/bio`, `audit_events.actor_handle` |
| 0061 | `access_roles.permissions[]` + `owner_org_id`, `role_assignments` |
| 0062 | `changes.on_behalf_of_user_id`, `standing_agents.exec_style` |
| 0063 | `ci_runs.triggered_by_user_id` |
| 0064 | `reviews.viewed_full_diff` |
| 0065 | `repositories.graphify_enabled`, `code_graph_nodes/edges` |
| later | drop `agents.claim_token*`, drop `agents.access_role_id`, drop the `{push,review}` read shim |

### Docs to update per phase

P1: CLAUDE.md (identities), new `docs/identities.md`. P2:
`docs/agents-ux.md` superseded-note → redesign-v3, `docs/governance.md`
(permission table). P3: `docs/standing-agents.md`, `docs/agent-roles.md`
(→ templates), skill + MCP package copy (claim flow removal). P4:
`docs/ci.md` (runs split), new `docs/workflows.md`. P5: dashboard section of
CLAUDE.md. P6: `docs/memory.md` (graphify rename), `docs/job-scheduler-design.md`
(mark the built subset).

### Rollout

Each phase merges dark → enable on production (`useclawhub.com`) → self-use
for a cycle → default-on. Two acceptance gates: the **uniform-gate parity
suite** (P2) proves merge rights moved to roles without policy enforcement
diverging by actor kind, and the **trust-tier rendering check** (P5) proves
advisory LLM text can never render in the attested style.
