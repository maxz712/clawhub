# ClawHub Dashboard

## Framework

Next.js 16 App Router, React 19, Tailwind 4, shadcn/ui (Base UI primitives). Dark theme only.

## Styling

- `src/app/globals.css` — theme tokens. Anchored in the landing-page palette: `--primary: #00e5a0`, `--background: #0a0a0c`, `--card: #16161b`, `--border: #2a2a33`.
- **Typography rule: Outfit for ALL UI text; JetBrains Mono ONLY for code** (diff lines, file contents, paths, SHAs, branch names, clone URLs, terminal mockups, `<code>`/`<pre>`). Loaded via `next/font/google` in `src/app/layout.tsx` as `--font-outfit` + `--font-jbmono` on `<html>` (must live on the root element — `html { @apply font-sans }` resolves there). `font-sans` → Outfit, `font-mono` → JetBrains in `@theme inline`; never reference a token from its own definition (var() cycle → font-family invalid → browser default). Public marketing pages with inline styles use `var(--font-outfit)` / `var(--font-jbmono)` directly.

## API client

`src/lib/api.ts` — single `api` instance (class `ApiClient`). Uses `localStorage.getItem("clawhub_token")` (user JWT) for `Authorization: Bearer`. Separate `clawhub_agent_token` exists for agent-scoped calls.

Methods cover the full v3 surface:
- Users: `loginUser`, `registerUser`, `getMe`
- Agents: `registerAgent`, `listAgents`, `claimAgent`, `getAgentMe`, `rotateAgentToken`
- Orgs: `createOrg`, `listOrgs`, `addOrgMember`
- Repos: `listRepos`, `getRepo`, `patchRepo`, `listCollaborators`, `addCollaborator`
- Changes: `listChanges`, `getChange`, `getDiff`, `mergeChange`, `rollbackChange`
- Reviews: `listReviews`, `submitReview`
- Issues: `listIssues`, `createIssue`, `patchIssue`, `addIssueComment`
- CI: `listPipelines`, `upsertPipeline`, `listCiRuns`
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
    │       │   └── [id]/page.tsx        # DiffReview (focused default) + discussion + actions sidebar
    │       ├── issues/
    │       │   ├── page.tsx             # Queue with filters + create dialog
    │       │   └── [num]/page.tsx       # Issue + comments
    │       └── settings/page.tsx        # Tabs: merge policy, CI, standing agents, secrets, webhooks
    ├── issues/                          # Top-level info page
    ├── agents/                          # UNIFIED AGENTS HUB — layout.tsx renders the shared TabBar; ALL hub routes live here:
    │                                    #   page.tsx(Overview+remove-agent) [id]/ roles/ standing/ memory/ fleet/ ops/(Incident ops) cost/ inbox/ sandboxes/ signatures/(Commit signatures)
    │   ├── page.tsx                     # Overview — register/claim + agent roster
    │   ├── [id]/page.tsx                # Agent detail: ONE page, sub-tabs (Overview/Limits/Quality/Versions/Evals/Cost/Governance). Merged the old /agents/[id]/ops console (redirected in next.config). Governance = per-agent kill switch + link to Incident ops.
    │   ├── standing/page.tsx            # Standing agents behind a repo <Select> (reuses StandingAgentsPanel)
    │   ├── memory/page.tsx              # Agent memory behind a repo <Select> (reuses MemoryView)
    │   └── fleet/page.tsx               # Org fleet behind an org <Select> (reuses FleetPane); /orgs/[id]/fleet stays canonical
    ├── roles/, cost/, inbox/,           # Hub tabs at their original routes (AgentsHubNav rendered on each)
    │   sandboxes/, attestations/, ops/  # ops = Incident ops (cross-agent kill/blast/rollback)
    ├── orgs/                            # Create; list; detail with member add
    └── settings/                        # User account
```

**Standing agents** — one shared `components/standing-agent-row.tsx` (`StandingAgentRow`: status map idle/running/paused/auto-paused/killed → matching badge, LABELED Run / Pause·Resume / Remove controls, inline run feedback, kill-switch-aware) renders rows in BOTH the per-repo `standing-agents-panel.tsx` and the hub "All repos" roster. `components/attach-standing-agent-dialog.tsx` is the create flow — fixed-repo (panel) or repo-picker (hub), so you can attach without drilling into a repo. `killed` is annotated onto the standing-agent list payloads from the kill-switch table. **Cost** is framed as self-reported BYO-LLM spend (ClawHub runs no inference). **Sandboxes** is an observability surface (agents launch them, not humans) with an allowed-image catalog. **Commit signatures** (formerly Attestations) verifies how a commit was made.

**Shared tab bar** — `components/tab-bar.tsx` (`TabBar`/`TabItem`/`isTabItemActive`) is the ONE horizontal-tab component: a scrollable `primary` strip, the overflow behind a pinned **More** dropdown, optional `end` tabs (e.g. repo Settings), active-into-view. Both `components/repo-tab-row.tsx` (`buildRepoTabs` → `TabBar`) and the Agents hub use it, so every tab surface looks + behaves identically. Never hand-roll another tab strip — feed `TabBar` a `TabItem[]`.

**Agents hub** — everything about agents (per-repo AND cross-repo) lives in one section under the **`/agents/*` URL**. `app/(app)/agents/layout.tsx` renders the shared `TabBar` for every hub route (hidden on the `/agents/[id]` detail drill-down) with **progressive disclosure**: core tabs (Overview/Roles/Standing agents/Memory) + Incident ops always show; Fleet/Cost/Inbox/Sandboxes/Commit signatures reveal once the user has ≥1 agent (the active tab always shows). The whole section was moved under `/agents/*` (roles/cost/inbox/sandboxes/ops/signatures relocated from root) with `next.config.ts` `redirects()` from every old path; **Attestations → Commit signatures** (`/agents/signatures`). Memory is no longer a repo tab — it's an agent feature, in the hub (with a repo switcher); `/repos/:ns/:repo/memory` redirects into it. Shared extractions: `components/memory-view.tsx` (`MemoryView`) + `components/fleet-pane.tsx` (`FleetPane`). Overview (`agents/page.tsx`) has a per-card **Remove** (archive) action → `api.deleteAgent`.

**Hub data model**: `FleetPane` takes a `FleetScope` (`{kind:"org",orgId}` | `{kind:"mine"}`) — the Fleet tab defaults to **My agents** (`api.getMyFleet`, `GET /api/v1/fleet`) so a solo user sees a real roster, with an org `<Select>`; org scope keeps role deploy/fan-out. Standing agents + Memory tabs default to a cross-repo **All repos** aggregate (`api.listMyStandingAgents` / `api.listMyMemory` → `GET /api/v1/standing-agents` / `/memory`), each grouped by repo with per-row actions routed back to the repo-scoped endpoints; picking a repo shows the full per-repo panel (`StandingAgentsPanel` / `MemoryView`). The `MergePolicyEditor` (repo Settings → Merge policy, and org policy) now has a **Verified autonomy** section (`verifiedAutonomy` {enabled,maxRisk,allowSensitivePaths,floorGlobs,minTier} + `autoMergeOnVerified` on the `MergePolicy` type) — persisted via the existing `patchRepo` (server `normalizeMergePolicy` already supported it). Note: Base UI `Select.Value` renders the raw value for sentinel keys (`__mine`/`__all`/`__any`) — use the function-child form `<SelectValue>{(v)=>label}</SelectValue>` to map them.

## Components (`src/components/`)

Kept: `risk-badge.tsx`, `status-badge.tsx`, `stat-card.tsx`.
New:
- `nav-sidebar.tsx` — grouped IA: core triage (Home/Repos/Import/Search/Notifications), then "Agents" (a single **Agents** link → the hub + Issues), then "Platform" (Orgs/Security/Marketplace/Admin) behind "More". The old "Agent fleet" group + fleet-link injection + Ops folded into the Agents hub. **Notifications now holds @-mentions as a tab** (the old `/mentions` nav entry + page were folded into `/notifications`; `/mentions` redirects). The bar itself is rendered by `app/(app)/agents/layout.tsx` via the shared `TabBar` (no more `agents-hub-nav.tsx`).
- `diff-review.tsx` + `lib/diff.ts` — the review surface: client-side unified-diff parser; per-file cards with old/new gutters; Review-Focus ranges get a flag gutter, amber tint, and inline note callouts; focused mode collapses unflagged regions behind expanders; prev/next flagged-file navigation
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
