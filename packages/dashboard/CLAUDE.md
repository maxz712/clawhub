# ClawHub Dashboard

## Framework

Next.js 16 App Router, React 19, Tailwind 4, shadcn/ui (Base UI primitives). Dark theme only.

## Styling

- `src/app/globals.css` — theme tokens. Anchored in the landing-page palette: `--primary: #00e5a0`, `--background: #0a0a0c`, `--card: #16161b`, `--border: #2a2a33`.
- Fonts loaded via `next/font/google` in `src/app/layout.tsx`: Outfit (display, `var(--font-display)`) + JetBrains Mono (mono, `var(--font-mono)`). Tailwind's `font-sans` maps to display; `font-mono` maps to mono.

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
├── login/, register/                    # Public auth
└── (app)/                               # Authenticated route group
    ├── layout.tsx                       # Redirects to /login if !isLoggedIn; renders NavSidebar
    ├── feed/                            # Home: "Needs your attention" triage queue + activity stream
    ├── repos/                           # Explorer
    │   └── [ns]/[repo]/
    │       ├── page.tsx                 # Repo home — Code (default, file browser + README) / changes/issues/releases tabs
    │       ├── changes/
    │       │   ├── page.tsx             # Change list
    │       │   └── [id]/page.tsx        # Focused review default (toggle to full)
    │       ├── issues/
    │       │   ├── page.tsx             # Queue with filters + create dialog
    │       │   └── [num]/page.tsx       # Issue + comments
    │       └── settings/page.tsx        # Tabs: merge policy, CI, secrets, webhooks
    ├── issues/                          # Top-level info page
    ├── agents/                          # Register + claim; list; detail with rotate-token
    ├── orgs/                            # Create; list; detail with member add
    └── settings/                        # User account
```

## Components (`src/components/`)

Kept: `risk-badge.tsx`, `status-badge.tsx`, `stat-card.tsx`.
New:
- `nav-sidebar.tsx` — grouped IA: core triage (Home/Repos/Issues/Search/Notifications/Mentions), then "Agents", then "Platform" sections
- `focused-diff-viewer.tsx` — default view for change detail; shadcn Tabs toggle to Full
- `change-metadata-card.tsx` — intent / risk / status / CI / scope / review-focus / merge banner
- `ci-status-pill.tsx` — colored pill with pulsing dot for `running`
- `issue-row.tsx` — row for issue lists
- `merge-policy-editor.tsx` — typed form against the `MergePolicy` shape
- `secret-row.tsx` — name + created-at + delete; plaintext never rendered
- `review-form.tsx` — verdict radio + summary textarea
- `activity-feed.tsx` — SSE-backed bounded event list
- `code-browser.tsx` — file explorer on the repo page Code tab: tree navigation, inline blob view with line numbers, rendered README at the root

Dropped from v2: `attention-card`, `decision-card`, `health-badge`, `oauth-buttons`, `file-browser`, `change-card`, OAuth callback pages.

## Dialog pattern

Base UI's `DialogTrigger` doesn't accept `asChild`. Pattern used: controlled dialog with an external `<Button onClick={() => setOpen(true)}>` sibling to the `<Dialog open={open} onOpenChange={setOpen}>`.

## Environment

`NEXT_PUBLIC_API_URL` — ClawHub API base URL (default `http://localhost:3000`).

## Testing

No automated tests — manual smoke via `npm -w @clawhub/dashboard run dev`.
