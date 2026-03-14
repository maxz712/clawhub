# ClawForge API

## Framework

Hono with nested route mounting. App setup in `src/app.ts`, server entry in `src/index.ts`.

## Route Mounting Order

Git Smart HTTP routes are mounted **first** at `/` (they handle `/:owner/:repo.git/...` and do their own auth). Then `/api/v1` routes.

## Middleware Order

CORS → git-http routes (own auth) → rate limiter (`/api/*`) → public routes → auth middleware (protected routes) → error handler (`app.onError`)

## Route Protection Pattern

```typescript
// Git Smart HTTP: mounted at root, handles own auth via authenticateGitRequest()
app.route("/", createGitHttpRoutes(db, gitService, eventBus));

// Public routes mount directly on app
app.route("/api/v1/agents", createAgentRoutes(db));
app.route("/api/v1/users", createUserRoutes(db));

// Protected routes: create sub-Hono, apply auth middleware, then mount
const protectedApi = new Hono();
protectedApi.use("*", authMiddleware);
protectedApi.route("/repos", createRepoRoutes(db, gitService, changeService));
protectedApi.route("/repos", createReviewRoutes(db, changeService, eventBus));
app.route("/api/v1", protectedApi);
```

## Rate Limiting

100 requests per 60 seconds per IP. In-memory Map store (not Redis). Middleware in `src/middleware/rateLimit.ts`.

## Database

- Drizzle ORM with PostgreSQL (`postgres` driver)
- Schema: `src/models/schema.ts`
- DB connection: `src/models/db.ts`
- Migrations: `drizzle/` directory
- Commands: `db:push` (dev), `db:generate` + `db:migrate` (production)

## Services

Each service is a class instantiated in `src/index.ts` and injected into app/routes:
- `GitService` — bare repo ops via `simple-git`
- `IntentEngine` — OpenRouter LLM classification
- `EventBus` — Redis Streams event publishing
- `ChangeService` — change lifecycle (depends on GitService, IntentEngine, EventBus, ChangeRefService)
- `ChangeRefService` — git plumbing for `refs/changes/` (uses `execFile`, not simple-git)

Services throw typed errors from `src/services/errors.ts`. Route handlers catch via the error handler middleware.

## Git Operations

- `GitService` uses `simple-git` for most operations
- `ChangeRefService` and `post-receive.ts` use `execFile` for low-level git plumbing commands
- `git-backend.ts` spawns `git-http-backend` CGI as child process
- Always resolve repo paths to absolute with `path.resolve()` — relative paths break when CWD changes

## Auth

- `authMiddleware` — Bearer token validation, sets `tokenPayload` on context
- `authenticateGitRequest()` — Bearer + Basic auth for git operations, returns null (doesn't throw) on missing auth
- Basic auth format: `agent-token:<jwt-token>` (username must be literally "agent-token")

## Intent Engine (`src/services/intent.ts`)

- Uses OpenRouter API via the OpenAI SDK (`openai` package), model: `anthropic/claude-sonnet-4`
- Falls back to heuristic analysis when `OPENROUTER_API_KEY` is not set or API call fails
- Classifies risk level (low/medium/high/critical) and generates human-readable summaries

## Key File Locations

```
src/
├── app.ts              # App setup, middleware, route mounting
├── index.ts            # Server entry — instantiates all services
├── routes/
│   ├── git-http.ts     # Git Smart HTTP protocol (own auth)
│   ├── agents.ts       # Agent CRUD (public + protected)
│   ├── repos.ts        # Repo CRUD + changes + permissions + /ask
│   ├── reviews.ts      # Review submission + listing
│   ├── users.ts        # Register, login, profile
│   ├── files.ts        # File tree, single file, batch files
│   ├── dashboard.ts    # Dashboard stats and activity
│   └── events.ts       # SSE event stream
├── services/
│   ├── git.ts          # GitService class (simple-git)
│   ├── git-backend.ts  # proxyToGitBackend (CGI spawner)
│   ├── change-refs.ts  # ChangeRefService class (git plumbing)
│   ├── post-receive.ts # processIncomingPush + parseConventionalCommits
│   ├── changes.ts      # ChangeService class (state machine)
│   ├── reviews.ts      # countReviewVerdicts
│   ├── intent.ts       # IntentEngine class
│   ├── permissions.ts  # evaluatePermissions
│   ├── events.ts       # EventBus (Redis Streams)
│   ├── auth.ts         # JWT + password utils
│   └── errors.ts       # Typed error classes
├── models/
│   ├── schema.ts       # Drizzle schema definitions
│   └── db.ts           # Database connection
└── middleware/
    ├── auth.ts         # JWT auth middleware + git auth helper
    ├── rateLimit.ts    # Rate limiting
    └── errorHandler.ts # Error → HTTP response
```

## Test Conventions

- Files: `tests/*.test.ts` (vitest)
- Vitest globals enabled
- Use `fs.mkdtemp` for temporary git repo fixtures in tests
- Test files: schema, auth, git, api, events, changes, intent, permissions
