# ClawHub Dashboard

## Framework

Next.js 16 App Router, React 19, Tailwind 4, shadcn/ui (Base UI primitives). Dark is the default; a light theme is also supported and user-togglable (see Theming below). The public landing page (`src/app/page.tsx`) stays dark-only regardless — it's inline-styled marketing, not part of the `(app)` shell.

## Theming

- `src/lib/theme.ts` — `getTheme`/`setTheme` (persist to `localStorage.clawhub_theme`, toggle the `dark` class on `<html>`) + `THEME_INIT_SCRIPT` (inlined into `<head>` by `src/app/layout.tsx` so the right class applies before first paint — no flash). `src/components/theme-toggle.tsx` is the sun/moon icon button wired into `nav-sidebar.tsx`'s footer (both the desktop sidebar and the mobile drawer render it, since both mount the same `navBody`).
- Dark stays the default for a first-time visitor (no stored preference) — light is opt-in via the toggle.
- `src/app/globals.css` — `:root` holds the LIGHT palette, `.dark` holds the DARK palette (toggled by the class above); both define the same token set (`--background`, `--card`, `--border`, etc.) via `@theme inline`. Code blocks (`.markdown-body pre`, Prism `.token.*`) stay a fixed dark palette in BOTH themes — a GitHub-dark-style code surface, not themed.
- `src/app/globals.css` — theme tokens. Dark palette anchored in the landing-page palette: `--primary: #00e5a0`, `--background: #0a0a0c`, `--card: #16161b`, `--border: #2a2a33`.
- **Typography rule: Outfit for ALL UI text; JetBrains Mono ONLY for code** (diff lines, file contents, paths, SHAs, branch names, clone URLs, terminal mockups, `<code>`/`<pre>`). Loaded via `next/font/google` in `src/app/layout.tsx` as `--font-outfit` + `--font-jbmono` on `<html>` (must live on the root element — `html { @apply font-sans }` resolves there). `font-sans` → Outfit, `font-mono` → JetBrains in `@theme inline`; never reference a token from its own definition (var() cycle → font-family invalid → browser default). Public marketing pages with inline styles use `var(--font-outfit)` / `var(--font-jbmono)` directly.

## API client

`src/lib/api.ts` — single `api` instance (class `ApiClient`). Uses `localStorage.getItem("clawhub_token")` (user JWT) for `Authorization: Bearer`. Separate `clawhub_agent_token` exists for agent-scoped calls.

Methods cover the full v3 surface:
- Users: `loginUser`, `registerUser`, `getMe`
- Agents: `registerAgent`, `listAgents`, `getAgentMe`, `rotateAgentToken` (claim flow removed in v3 — agents are created by humans)
- Orgs: `createOrg`, `listOrgs`, `addOrgMember`
- Repos: `listRepos`, `getRepo`, `patchRepo`, `listCollaborators`, `addCollaborator`
- Changes: `listChanges`, `getChange`, `getDiff`, `mergeChange`, `rollbackChange`
- Reviews: `listReviews`, `submitReview`
- Issues: `listIssues`, `createIssue`, `patchIssue`, `addIssueComment`
- CI: `listPipelines`, `upsertPipeline`, `listCiRuns`
- Workflow runs (v3 P4): `listWorkflowRuns`, `getWorkflowRun`, `listMyWorkflowRuns`; `addComment`/`addIssueComment` return an optional `workflowRun` dispatch result for slash-command comments; `submitReview` accepts `viewedFullDiff`
- Secrets: `listSecrets`, `setSecret`, `deleteSecret`
- Releases: `listReleases`, `createRelease`
- Webhooks: `listWebhooks`, `createWebhook`, `deleteWebhook`
- Events: `eventStreamUrl()` — use with `EventSource`

## Auth helpers

`src/lib/auth.ts` — `getToken` / `setToken` / `isLoggedIn` / `logout` (clears both user + agent tokens) / `getStoredUser` / agent-token variants.

## Page structure

```
src/app/
├── page.tsx                             # Landing (dark, inline-styled, matches product marketing)
├── login/, register/                    # Public auth; login shows OAuth buttons for configured providers
│   └── login/oauth/                     # OAuth landing — stores JWT from URL fragment
└── (app)/                               # Authenticated route group
    ├── layout.tsx                       # Redirects to /login if !isLoggedIn; renders NavSidebar
    ├── feed/                            # Home: "Needs your attention" triage queue + activity stream
    ├── repos/                           # Explorer
    │   └── [ns]/[repo]/
    │       ├── page.tsx                 # Repo home — RepoHeader (tabs + star/watch/fork) + clone + tree + README
    │       ├── tree/[...slug]/          # /tree/<ref>/<path> — URL-addressable dirs (ref resolved against branch list, slashes ok)
    │       ├── blob/[...slug]/          # /blob/<ref>/<path> — file view; clickable line numbers → #L10 / #L10-L20 (shift-click), deep links highlight + scroll
    │       ├── releases/, activity/     # Repo tabs
    │       ├── changes/
    │       │   ├── page.tsx             # Change list
    │       │   └── [id]/page.tsx        # ONE review feed (v3 P5): description → ChangeStatusStrip → focused DiffReview (inline advisory annotations) → discussion; actions sidebar
    │       ├── issues/
    │       │   ├── page.tsx             # Queue with filters + create dialog
    │       │   └── [num]/page.tsx       # Issue + comments
    │       ├── ci/page.tsx              # CI — first-class repo tab (runs + pipelines via PipelineEditor)
    │       ├── workflow-runs/page.tsx   # Runs — Workflow Runs tab (v3 P4): agent-origin runs, WorkflowRunsTable w/ inline timeline detail
│       └── settings/page.tsx        # Tabs: general, collaborators, merge policy, integrations, secrets, webhooks (CI → /ci; standing agents → the hub)
    ├── issues/                          # Top-level info page
    ├── roles/                           # TOP-LEVEL access-roles (RBAC) editor — v4: roles govern humans AND agents,
    │                                    # so they live in the nav next to People. /agents/roles redirects here.
    ├── agents/                          # UNIFIED AGENTS HUB — layout.tsx renders the shared TabBar; v4 tab set:
    │                                    #   Overview / Keys / Workflows / Runs / Memory / Ops (+More: Cost, Inbox, Commit signatures)
    │   ├── page.tsx                     # Overview — a ROSTER (not a control panel): Wrappers (run locally) vs Standing (ClawHub-run;
    │   │                                # role-minted workers fold in as peers — no "Deployed by roles" sub-group). Names link to
    │   │                                # /people/<name>; deployment rows carry provider/model chips + Run now (runDeployment for
    │   │                                # global repo-less rows, runStandingAgent for legacy per-repo rows) + Edit (model/key/enabled
    │   │                                # via updateDeployment, global only) + Remove (deleteDeployment / deleteStandingAgent)
    │   ├── [id]/page.tsx                # v4: thin CLIENT redirect → /people/<agent-name> (preserves ?tab=). The management surface moved into components/agent-admin-panel.tsx, rendered on the agent's identity page when the viewer governs it.
    │   ├── keys/page.tsx                # Keys — the BYO LLM key vault: list/add/delete (sealed at rest; deleting never bricks a running deployment)
    │   ├── workflows/page.tsx           # Workflows — THE work surface (v4): list w/ trigger summary + enabled toggle + scope chip + Run
    │   │   └── [id]/page.tsx            # now/Edit/Delete; "Start from a template" cards (listWorkflowTemplates) prefill the shared
    │   │                                # components/workflow-dialog.tsx; [id] = activity view (getWorkflowActivity: runs + produced reviews/changes)
    │   ├── runs/page.tsx                # Runs — cross-repo Workflow Runs (listMyWorkflowRuns, repo column)
    │   ├── memory/page.tsx              # Agent memory behind a repo <Select> (reuses MemoryView)
    │   └── ops/page.tsx                 # Ops — incident levers (kill/blast/rollback) behind a scope select: "Personal agents" | one entry per org
    ├── orgs/                            # Create; list; detail with member add (+ orgs/[id]/fleet, still the canonical FleetPane home)
    └── settings/                        # User account
```

**Deployments + workflows (v4)** — deployments (standing agents) are repo-LESS: identity + access role + LLM provider only, created via the New-agent dialog and managed inline on the Overview roster. WORKFLOWS are their own entity owning instructions + cadence + optional repo scope (default all) — `agents/workflows/page.tsx` + the shared `components/workflow-dialog.tsx` (create/edit + template prefill + `triggerSummary` helper). The old hub pages for Standing agents / Fleet / Templates / Sandboxes were DELETED (redirects in next.config.ts: standing/fleet/sandboxes → /agents, templates → /agents/workflows); `standing-agents-panel.tsx`, `standing-agent-row.tsx`, `attach-standing-agent-dialog.tsx` and `fleet-pane.tsx` remain as components (repo Settings legacy + `orgs/[id]/fleet`). **Cost** is framed as self-reported BYO-LLM spend (ClawHub runs no inference). **Commit signatures** (formerly Attestations) verifies how a commit was made.

**Shared tab bar** — `components/tab-bar.tsx` (`TabBar`/`TabItem`/`isTabItemActive`) is the ONE horizontal-tab component: a scrollable `primary` strip, the overflow behind a pinned **More** dropdown, optional `end` tabs (e.g. repo Settings), active-into-view. Both `components/repo-tab-row.tsx` (`buildRepoTabs` → `TabBar`) and the Agents hub use it, so every tab surface looks + behaves identically. Never hand-roll another tab strip — feed `TabBar` a `TabItem[]`.

**Agents UX model (v4)** — everything is an IDENTITY (agent actions render like human ones + a bot marker); agents are created BY humans. The ONE "New agent" dialog (`components/new-agent-dialog.tsx`) is identity-only: name + access-role dropdown (with inline role create) + runs local/deployed + (deployed) an LLM choice — "Platform (metered)" with the agentic-filtered model select OR "Bring your own key" with a vault dropdown + inline add-key mini-form. NO repo multi-select, NO instruction presets, NO cadence — workflows own those; the deployed-success screen links to the Workflows tab ("Deployed. Give it work in the Workflows tab."). `createManagedAgent` is called without repoIds/instructions/cadence. No container knobs anywhere in the UI. `TabBar` computes More DYNAMICALLY (ResizeObserver + hidden inert measurement row — nothing scrolls, no phantom scrollbar; `.no-scrollbar` utility for other strips).

**Agents hub** — everything about agents lives in one section under the **`/agents/*` URL**. `app/(app)/agents/layout.tsx` renders the shared `TabBar` for every hub route (hidden on the `/agents/[id]` detail drill-down). v4 tab set: **Overview / Keys / Workflows / Runs / Memory / Ops** always show; Cost/Inbox/Commit signatures sit behind "More" and reveal once the user has ≥1 agent (the active tab always shows). Access **Roles moved top-level** (`/roles`, nav next to People; `/agents/roles` redirects). **Attestations → Commit signatures** (`/agents/signatures`). Memory is not a repo tab — it's an agent feature, in the hub (with a repo switcher); `/repos/:ns/:repo/memory` redirects into it. Shared extractions: `components/memory-view.tsx` (`MemoryView`) + `components/fleet-pane.tsx` (`FleetPane`). Overview (`agents/page.tsx`) has a per-card **Remove** (archive) action → `api.deleteAgent`.

**Hub data model**: the Overview roster joins `api.listAgents()` with `api.listMyStandingAgents()` (`GET /api/v1/standing-agents` — v4 global deployments have `repoNs`/`repoName` null; legacy per-repo rows keep them set, and per-row actions route to the matching endpoint). Workflows come from `api.listWorkflows`/`createWorkflow`/`updateWorkflow`/`deleteWorkflow`/`runWorkflow`/`getWorkflowActivity` + `listWorkflowTemplates` (the slash presets). Keys come from `listLlmKeys`/`createLlmKey`/`deleteLlmKey`. The Memory tab defaults to a cross-repo **All repos** aggregate (`api.listMyMemory`); picking a repo shows the full `MemoryView`. `FleetPane` (a `FleetScope` `{kind:"org",orgId}` | `{kind:"mine"}`) now renders only at `orgs/[id]/fleet`. The `MergePolicyEditor` (repo Settings → Merge policy, and org policy) has a **Verified autonomy** section (`verifiedAutonomy` {enabled,maxRisk,allowSensitivePaths,floorGlobs,minTier} + `autoMergeOnVerified` on the `MergePolicy` type) — persisted via the existing `patchRepo` (server `normalizeMergePolicy` already supported it). Note: Base UI `Select.Value` renders the raw value for sentinel keys (`__mine`/`__all`/`__any`) — use the function-child form `<SelectValue>{(v)=>label}</SelectValue>` to map them.

## Components (`src/components/`)

Kept: `risk-badge.tsx`, `status-badge.tsx`, `stat-card.tsx`.
New:
- `nav-sidebar.tsx` — grouped IA: core triage (Home/Repos/Import/Search/People/**Roles**/Notifications — Roles is the top-level RBAC editor, v4), then "Agents" (a single **Agents** link → the hub), then "Platform" (Orgs/Security/Marketplace/Admin) behind "More". The old "Agent fleet" group + fleet-link injection + Ops folded into the Agents hub. **Notifications now holds @-mentions as a tab** (the old `/mentions` nav entry + page were folded into `/notifications`; `/mentions` redirects). The bar itself is rendered by `app/(app)/agents/layout.tsx` via the shared `TabBar` (no more `agents-hub-nav.tsx`).
- `diff-review.tsx` + `lib/diff.ts` — the review surface: client-side unified-diff parser; per-file cards with old/new gutters; Review-Focus ranges get a flag gutter, amber tint, and inline note callouts with PROVENANCE badges (author flag / deterministic / reviewer); an `advisoryFocus` prop renders the native reviewer's findings as inline violet+bot "advisory" rows (never styled like attested content — v3 P5 trust rule); focused mode collapses unflagged regions behind expanders AND zero-annotation files to header rows; "Expand all" + the Full-diff toggle fire `onFullView` (the page records `viewedFullDiff` on review submissions); prev/next flagged-file navigation
- `agent-admin-panel.tsx` — `AgentAdminPanel({ agentId })`: the FULL management surface for one agent you govern (sub-tabs Overview/Limits/Quality/Versions/Evals/Cost/Governance; all data fetching inside; honors a `?tab=` deep-link). v4 identity consolidation: it renders on `/people/[handle]` when the identity is an agent with `ownerUserId === getStoredUser().id` (the profile card gets a "You govern this agent" line); `/agents/[id]` is now just a client redirect to `/people/<name>` (not-found → `/agents`).
- `change-status-strip.tsx` — the status strip on the change page (v3 P5 + v4 dedupe): ONE compact row per signal, each signal in EXACTLY ONE row (Risk · CI · Focus · Verify · Advisory · Reviews · Scope). The old Evidence row (EvidencePanel) is GONE — it duplicated CI/verify/risk; its unique content became the **Reviews** row (reviewer verdicts + basis chips + attached evidence, via `ReviewVerdictsList` — the extraction that replaced `EvidencePanel` in `evidence-panel.tsx`) and the **Scope** row (scope-path chips, first 15 + "+N more"). The CI row takes a page-fetched `ciRuns` prop (`api.listCiRuns(ns, repo, changeId)`): the status chip links to `/repos/:ns/:repo/ci?run=<id>` for the newest run at the change's HEAD commit (no run → no link), and the expansion lists every run for the change, each linked the same way; the CI page reads `?run=` (window.location, no useSearchParams Suspense needed) and `PipelineEditor`/`RunsList` scroll to + ring-highlight that row. VerificationPanel stays the Verify expansion; AdvisoryReviewCard stays the Advisory expansion.
- `workflow-runs-table.tsx` — shared Workflow Runs table (repo Runs tab + hub Runs tab): status pill, agent identity, mode, task, triggeredBy, metered cost, relative time. v4: the expanded detail (getWorkflowRunV4) LEADS with a "Produced" block — review-verdict chips ("✓ approved (code)") + a Change link — because runs produce activity (reviews, Changes); execution is plumbing, demoted to a collapsed "Execution details" disclosure (timeline + steps + logs + model/commit meta).
- `slash-command-hint.tsx` — composer affordance for thread slash commands (v3 P4): `SlashCommandHint` (hint row when a draft starts with "/"), `WorkflowDispatchNotice` (post-POST "dispatched to @agent" / not-dispatched note), `isSlashCommandDraft`. Change-thread slash comments auto-anchor to a synthetic `discussion:0` thread (the comments API requires path+line for a new thread).
- `change-metadata-card.tsx` — intent / risk / status / CI / scope / review-focus / merge banner
- `ci-status-pill.tsx` — colored pill with pulsing dot for `running`
- `issue-row.tsx` — row for issue lists
- `merge-policy-editor.tsx` — typed form against the `MergePolicy` shape
- `secret-row.tsx` — name + created-at + delete; plaintext never rendered
- `review-merge-panel.tsx` — the unified review→merge surface: verdict radios (approve/request_changes/comment) + basis + summary + evidence, and ONE context-aware split button that reads the merge gate + the caller's `access` to offer the most useful action (Approve / Approve & merge / Merge), with the alternative behind an in-flow ▾ (the Card clips overflow, so no absolute popover). Replaces the old split between a separate merge control and `review-form.tsx`.
- `request-reviewers-card.tsx` — reviewers sidebar: shows **auto-reviewers** (review-mode standing agents on `change.opened`, fetched via `listStandingAgentsSafe` so a non-operator's 401 can't trip the global logout) separately from one-off **requested** reviewers; requesting a standing reviewer dispatches it server-side.
- `activity-feed.tsx` — SSE-backed bounded event list
- `repo-header.tsx` — GitHub-style repo hub header: star/watch/fork state + tab row owning repo-scoped nav (Code/Changes/Issues/Releases/Activity/Settings + Security/Packages/Milestones/Audit)
- `tree-listing.tsx` / `blob-view.tsx` / `branch-select.tsx` + `lib/repo-path.ts` — URL-driven code browsing; `splitRefPath` resolves slash-containing branch names greedily against the branch list
- `lib/highlight.ts` — Prism-based per-line syntax highlighting (GitHub-dark token palette in globals.css); used by the diff viewer and code browser. Per-line tokenizing loses multi-line comment state — accepted trade-off.

Dropped from v2: `attention-card`, `decision-card`, `health-badge`, `oauth-buttons`, `file-browser`, `change-card`, OAuth callback pages.

## Dialog pattern

Base UI's `DialogTrigger` doesn't accept `asChild`. Pattern used: controlled dialog with an external `<Button onClick={() => setOpen(true)}>` sibling to the `<Dialog open={open} onOpenChange={setOpen}>`.

## Environment

`NEXT_PUBLIC_API_URL` — ClawHub API base URL (default `http://localhost:3000`).

## Testing

No automated tests — manual smoke via `npm -w @clawhub/dashboard run dev`.
