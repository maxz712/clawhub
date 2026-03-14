# ClawForge Dashboard

## Framework

Next.js 16 with App Router, React 19, TypeScript.

## Styling

Tailwind CSS 4 + shadcn/ui components in `src/components/ui/`.

## API Client

Singleton `ApiClient` in `src/lib/api.ts` — exported as `api`. Use existing methods before adding new ones. The client:
- Reads JWT token from `localStorage` (`clawforge_token`)
- Sets `Authorization: Bearer <token>` on all requests
- Throws on non-OK responses with parsed error messages

Available methods: `register`, `login`, `getMe`, `getStats`, `getActivity`, `getRepos`, `getAgents`, `createRepo`, `getRepo`, `getChanges`, `getChange`, `approveChange`, `rejectChange`, `mergeChange`, `rollbackChange`, `getCommits`, `getReviews`, `submitReview`, `listFiles`, `getFile`, `registerAgent`, `getPermissions`, `createPermission`, `deletePermission`, `getEventStreamUrl`.

## Auth

- Token stored in `localStorage` as `clawforge_token`
- Auth helpers in `src/lib/auth.ts`
- Login/register pages handle token storage

## Page Structure

```
src/app/
├── page.tsx                                    # Landing / redirect
├── login/page.tsx                              # Login form
├── register/page.tsx                           # Registration form
└── dashboard/
    ├── layout.tsx                              # Dashboard shell with nav sidebar
    ├── page.tsx                                # Home — stats + activity feed
    ├── repos/
    │   ├── page.tsx                            # Repository list
    │   └── [id]/
    │       ├── page.tsx                        # Repo detail — file browser, changes, clone URL, commit history
    │       ├── permissions/page.tsx            # Permission rule management
    │       └── changes/[changeId]/page.tsx     # Change detail — diff, reviews, approve/reject/merge/rollback
    └── agents/page.tsx                         # Agent list + registration
```

## Reusable Components (`src/components/`)

| Component | Purpose |
|-----------|---------|
| `nav-sidebar.tsx` | Dashboard navigation sidebar |
| `activity-feed.tsx` | Real-time activity stream |
| `file-browser.tsx` | Repository file tree viewer |
| `change-card.tsx` | Change summary card |
| `stat-card.tsx` | Dashboard statistic card |
| `status-badge.tsx` | Change status indicator |
| `risk-badge.tsx` | Risk level indicator |

shadcn/ui primitives in `src/components/ui/`: button, card, input, label, badge, table, tabs, dialog, select, textarea, alert, separator.

## Real-Time Updates

SSE via `api.getEventStreamUrl()` — returns the URL for the server-sent events stream at `/api/v1/events/stream`.

## Testing

No automated tests currently — manual testing only.

## Environment

`NEXT_PUBLIC_API_URL` — API base URL (default: `http://localhost:3000`). Set in `.env.local` or root `.env`.
