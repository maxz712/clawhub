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
    ├── agents/                          # Register + claim; list; detail with rotate-token
    ├── orgs/                            # Create; list; detail with member add
    └── settings/                        # User account
```

## Components (`src/components/`)

Kept: `risk-badge.tsx`, `status-badge.tsx`, `stat-card.tsx`.
New:
- `nav-sidebar.tsx` — grouped IA: core triage (Home/Repos/Issues/Search/Notifications/Mentions), then "Agents", then "Platform" sections
- `diff-review.tsx` + `lib/diff.ts` — the review surface: client-side unified-diff parser; per-file cards with old/new gutters; Review-Focus ranges get a flag gutter, amber tint, and inline note callouts; focused mode collapses unflagged regions behind expanders; prev/next flagged-file navigation
- `change-metadata-card.tsx` — intent / risk / status / CI / scope / review-focus / merge banner
- `ci-status-pill.tsx` — colored pill with pulsing dot for `running`
- `issue-row.tsx` — row for issue lists
- `merge-policy-editor.tsx` — typed form against the `MergePolicy` shape
- `secret-row.tsx` — name + created-at + delete; plaintext never rendered
- `review-form.tsx` — verdict radio + summary textarea
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
