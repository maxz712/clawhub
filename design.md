# AI-Native GitHub — Technical Architecture & Build Plan

## Product Name TBD — Working Title: "ClawForge"

---

## 1. Core Concept

A code hosting and collaboration platform where AI agents (starting with OpenClaw) are first-class citizens. Humans supervise, approve, and direct — agents do the work. Git compatibility under the hood, but the interaction layer is designed for agents and the supervision layer is designed for humans.

---

## 2. Technical Architecture

### 2.1 System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        AGENT LAYER                              │
│                                                                 │
│  OpenClaw Skill ←──→  Agent Gateway API  ←──→  Claude Code     │
│  (MCP/WebSocket)       (REST + WebSocket)       Cursor, Devin   │
│                              │                   (future)       │
└──────────────────────────────┼───────────────────────────────────┘
                               │
┌──────────────────────────────┼───────────────────────────────────┐
│                        CORE PLATFORM                            │
│                              ▼                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────┐   │
│  │  Intent      │   │  Repository  │   │  Permission &     │   │
│  │  Engine      │   │  Service     │   │  Identity Service │   │
│  │              │   │              │   │                   │   │
│  │  - Parse     │   │  - Git ops   │   │  - Agent scoping  │   │
│  │  - Classify  │   │  - Storage   │   │  - Path rules     │   │
│  │  - Validate  │   │  - Branching │   │  - Approval gates │   │
│  │  - Enrich    │   │  - Diffing   │   │  - Audit trail    │   │
│  └──────┬───────┘   └──────┬───────┘   └───────┬───────────┘   │
│         │                  │                   │               │
│         └──────────┬───────┴───────────────────┘               │
│                    ▼                                            │
│            ┌──────────────┐                                     │
│            │  Event Bus   │  (all actions → events)             │
│            │  (NATS/Redis │                                     │
│            │   Streams)   │                                     │
│            └──────┬───────┘                                     │
│                   │                                             │
└───────────────────┼─────────────────────────────────────────────┘
                    │
┌───────────────────┼─────────────────────────────────────────────┐
│                   ▼          HUMAN LAYER                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │          Supervision Dashboard (Web)                      │   │
│  │                                                           │   │
│  │  - Activity feed (what agents are doing)                  │   │
│  │  - Intent-based change review                             │   │
│  │  - One-click approve / reject / rollback                  │   │
│  │  - Agent management & permissions                         │   │
│  │  - Repo explorer with semantic search                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │     Notification Layer (Telegram, Slack,                  │   │
│  │     Email, OpenClaw channel-back)                         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Model

```
Agent
  id              UUID
  name            string        "felix-openclaw"
  type            enum          openclaw | claude_code | cursor | generic
  owner_id        UUID          → User
  public_key      text          for request signing
  created_at      timestamp
  metadata        jsonb         openclaw config, model info, etc.

User (Human)
  id              UUID
  email           string
  auth_provider   enum          github_oauth | email | api_key
  created_at      timestamp

Repository
  id              UUID
  name            string
  owner_id        UUID          → User
  git_path        string        bare repo path on disk
  description     text
  default_branch  string
  created_at      timestamp

Change (replaces PR concept)
  id              UUID
  repo_id         UUID          → Repository
  agent_id        UUID          → Agent (nullable, could be human)
  intent          text          "Add OAuth2 support to auth module"
  description     text          AI-generated summary of what changed
  status          enum          pending | approved | rejected | merged | rolled_back
  risk_level      enum          low | medium | high | critical
  branch          string        the working branch
  diff_summary    jsonb         files changed, lines added/removed
  semantic_diff   jsonb         structured description of behavioral changes
  created_at      timestamp
  reviewed_at     timestamp
  reviewed_by     UUID          → User (nullable)

PermissionRule
  id              UUID
  repo_id         UUID          → Repository
  agent_id        UUID          → Agent (nullable = all agents)
  rule_type       enum          allow_path | deny_path | require_approval | auto_merge
  pattern         string        glob pattern: "src/auth/**", "*.config.*"
  conditions      jsonb         e.g. { "max_files": 5, "no_deletions": true }

AuditEvent
  id              UUID
  repo_id         UUID
  agent_id        UUID
  action          string        "clone", "push", "change_created", "change_merged"
  metadata        jsonb
  timestamp       timestamp
```

### 2.3 Agent Gateway API

This is the primary interface agents interact with. Designed for tool-use patterns (MCP-compatible).

```
POST   /api/v1/repos                        Create repository
GET    /api/v1/repos/:id                     Get repo info + codebase summary
POST   /api/v1/repos/:id/changes             Submit a change (with intent)
GET    /api/v1/repos/:id/changes              List changes
GET    /api/v1/repos/:id/changes/:id          Get change status
POST   /api/v1/repos/:id/ask                  Ask a question about the codebase

# Git-compatible endpoints (for backwards compat)
POST   /api/v1/repos/:id/git/push            Standard git push (intent extracted)
GET    /api/v1/repos/:id/git/clone            Clone info

# Agent management
POST   /api/v1/agents                         Register agent
GET    /api/v1/agents/:id/activity             Agent activity log
PUT    /api/v1/agents/:id/permissions          Update permissions
```

**Example: Agent submits a change**

```json
POST /api/v1/repos/abc123/changes
Authorization: Bearer <agent-token>

{
  "intent": "Fix the stale cache bug reported in issue #42",
  "description": "The profile update endpoint was not invalidating the Redis cache. Added cache invalidation after successful DB write. Also added a test.",
  "branch": "fix/stale-profile-cache",
  "files": [
    {
      "path": "src/api/profile.ts",
      "action": "modify",
      "diff": "...",
      "explanation": "Added cache.invalidate() call after db.update()"
    },
    {
      "path": "tests/api/profile.test.ts",
      "action": "modify",
      "diff": "...",
      "explanation": "Added test for cache invalidation on profile update"
    }
  ],
  "risk_assessment": {
    "level": "low",
    "reasoning": "Small, targeted change. Only affects profile update path. Test coverage added."
  }
}
```

### 2.4 Intent Engine

Sits between the agent API and the repository service. Its job:

1. **Parse**: Extract structured intent from agent submissions (or infer from raw git pushes)
2. **Classify risk**: Based on files touched, scope of change, permission rules
3. **Route**: Auto-merge low-risk changes that match rules, queue others for human review
4. **Enrich**: Generate human-readable summaries, highlight architectural implications

For the MVP, this can be a relatively thin layer — use an LLM call (Claude Sonnet) to classify risk and generate summaries. No need to build custom ML.

### 2.5 Tech Stack (MVP)

```
Backend:        TypeScript / Node.js (Hono or Fastify)
Database:       PostgreSQL + pgvector (for codebase semantic search later)
Git storage:    Bare git repos on disk (or gitea/gitaly lib for operations)
Event bus:      Redis Streams (upgrade to NATS later if needed)
Auth:           JWT tokens for agents, OAuth for humans
Frontend:       Next.js (supervision dashboard)
Hosting:        Single VPS to start (Hetzner/Railway), containerized
CI:             GitHub Actions for the platform itself (ironic but practical)
```

### 2.6 OpenClaw Skill (The Adoption Driver)

The OpenClaw skill is the most important piece for go-to-market. It should be dead simple:

```yaml
# openclaw skill config
name: clawforge
description: Push code, create repos, and manage changes on ClawForge
tools:
  - name: clawforge_push
    description: Submit a code change with intent to a ClawForge repository
    parameters:
      repo: string
      intent: string
      files: array
  - name: clawforge_status
    description: Check the status of your changes
    parameters:
      repo: string
  - name: clawforge_ask
    description: Ask a question about a codebase on ClawForge
    parameters:
      repo: string
      question: string
```

The skill connects to the Agent Gateway API. An OpenClaw user types "push the auth fix to ClawForge" and their agent handles the rest.

---

## 3. Build Plan — First 6 Weeks

### Week 1: Foundation

**Goal: Bare minimum backend that can receive and store code from an agent.**

Tasks (feed these to your code agent):
- Set up TypeScript project with Hono/Fastify, PostgreSQL, basic project structure
- Implement bare git repo creation and management (use `simple-git` or shell out to git)
- Build the core API endpoints: create repo, submit change, get change status
- Agent auth: simple API key/JWT token generation and validation
- Database schema: agents, users, repositories, changes tables
- Basic Docker Compose setup (app + postgres + redis)

**Deliverable**: An agent can register, create a repo, and push a change via API. No UI yet.

### Week 2: Permission System + Change Processing

**Goal: Changes flow through a permission check and get queued for review.**

Tasks:
- Implement PermissionRule model and evaluation engine
- Build the Intent Engine as a thin LLM wrapper (call Claude Sonnet API to classify risk, generate summaries)
- Change status machine: pending → approved/rejected → merged/rolled_back
- Git branch management: each change creates a branch, merge on approval
- Event emission: every action writes to Redis Streams
- Audit event logging

**Deliverable**: Agent submits a change → system classifies risk → routes to auto-merge or human review queue.

### Week 3: Supervision Dashboard v1

**Goal: A human can see what agents are doing and approve/reject changes.**

Tasks:
- Next.js app with auth (start with email magic link or GitHub OAuth)
- Activity feed: real-time stream of agent actions across repos
- Change review view: shows intent, file changes, risk level, semantic diff
- Approve / reject / rollback buttons with confirmation
- Agent management page: see registered agents, their activity, edit permissions
- Repository list and basic file browser

**Deliverable**: A human can log in, see their agents' activity, review changes, and approve/reject.

### Week 4: OpenClaw Skill + Integration Testing

**Goal: An OpenClaw user can connect their agent and start using the platform.**

Tasks:
- Build the OpenClaw skill package (MCP-compatible tool definitions)
- Skill installation docs and one-command setup
- End-to-end testing: OpenClaw agent → skill → API → git → review → merge
- WebSocket notifications: push change status back to agent in real-time
- Notification hooks: Telegram/Slack messages when changes need review
- Error handling and graceful degradation (what happens when the LLM intent classification fails?)

**Deliverable**: Full loop works. OpenClaw user types a command, agent pushes code, human gets notified, reviews, merges.

### Week 5: Polish + Git Compatibility Layer

**Goal: Support standard git operations alongside the agent API.**

Tasks:
- Git HTTP smart protocol support (so `git clone` and `git push` work)
- Intent extraction from conventional commit messages (for when agents or humans use raw git)
- Dashboard improvements: diff viewer, file tree, commit history
- Agent identity display in git log (agent commits attributed properly)
- Repository settings: default permission rules, auto-merge policies
- Basic API docs / OpenAPI spec

**Deliverable**: Platform works for both agent-native and git-native workflows.

### Week 6: Launch Prep + Community

**Goal: Ship to OpenClaw community.**

Tasks:
- Landing page explaining the concept
- Publish OpenClaw skill to ClawHub (or equivalent skill directory)
- Write setup guide targeting OpenClaw users
- Record demo video: "Watch an OpenClaw agent push code and a human review it"
- Set up basic monitoring, error tracking, rate limiting
- Security audit: token management, input validation, git operation sandboxing
- Soft launch to OpenClaw Discord, post on X

**Deliverable**: Public beta. OpenClaw users can sign up and start using it.

---

## 4. Agent Instructions for Code Agents

If you're feeding this plan to code agents (Claude Code, Cursor, etc.), here's how to structure the prompts:

### Repo Structure to Generate

```
clawforge/
├── packages/
│   ├── api/                    # Backend API service
│   │   ├── src/
│   │   │   ├── routes/         # API route handlers
│   │   │   ├── services/       # Business logic
│   │   │   │   ├── git.ts      # Git operations wrapper
│   │   │   │   ├── intent.ts   # Intent engine (LLM classification)
│   │   │   │   ├── permissions.ts
│   │   │   │   └── changes.ts
│   │   │   ├── models/         # DB models / Drizzle schema
│   │   │   ├── middleware/     # Auth, rate limiting
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── dashboard/              # Next.js supervision UI
│   │   ├── app/
│   │   │   ├── dashboard/
│   │   │   ├── repos/
│   │   │   ├── agents/
│   │   │   └── review/
│   │   └── package.json
│   │
│   └── openclaw-skill/         # OpenClaw skill package
│       ├── skill.yaml
│       ├── tools/
│       └── README.md
│
├── docker-compose.yml
├── .env.example
└── README.md
```

### Key Prompts for Your Code Agent

**Prompt 1 — Project Bootstrap:**
> Set up a TypeScript monorepo called "clawforge" using npm workspaces. Three packages: api (Hono + Drizzle ORM + PostgreSQL), dashboard (Next.js 14 + Tailwind + shadcn/ui), and openclaw-skill. Include Docker Compose with PostgreSQL 16 and Redis 7. The API should have health check and basic error handling middleware.

**Prompt 2 — Database Schema:**
> Using Drizzle ORM, create the schema for: agents (id, name, type, owner_id, public_key, metadata, created_at), users (id, email, auth_provider, created_at), repositories (id, name, owner_id, git_path, description, default_branch, created_at), changes (id, repo_id, agent_id, intent, description, status, risk_level, branch, diff_summary, semantic_diff, created_at, reviewed_at, reviewed_by), permission_rules (id, repo_id, agent_id, rule_type, pattern, conditions), audit_events (id, repo_id, agent_id, action, metadata, timestamp). Add proper indexes and foreign keys.

**Prompt 3 — Git Service:**
> Create a git service module that wraps bare git operations. It should be able to: init a bare repo at a given path, create branches, apply diffs to a branch, merge a branch to main, get diff between branches, list files in a branch, get file contents, and rollback a merge. Use simple-git library. All operations should be async and throw typed errors.

**Prompt 4 — Agent API Routes:**
> Build the agent-facing API routes: POST /agents (register), POST /repos (create), POST /repos/:id/changes (submit change with intent, files, risk_assessment), GET /repos/:id/changes (list), GET /repos/:id/changes/:id (status). Auth via Bearer token (JWT). Each change submission should: validate permissions, call the intent engine, store the change, apply the diff to a new branch, emit an event to Redis Streams, and return the change ID.

---

## 5. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Git operation security (arbitrary code via diffs) | Critical | Sandbox git operations, validate diffs before applying, no executable file permissions |
| Agent token compromise | High | Short-lived tokens, scope to specific repos, revocation endpoint |
| LLM intent classification unreliable | Medium | Fallback to manual classification, let humans override, log accuracy |
| OpenClaw API/skill format changes | Medium | Abstract the skill interface, version the API |
| Low adoption | High | Ship the OpenClaw skill first, optimize for that community's workflow |
| Git storage costs at scale | Medium | Start on disk, migrate to object storage later |

---

## 6. Success Metrics (First 90 Days)

- **10+ OpenClaw agents connected** in the first 2 weeks post-launch
- **100+ changes processed** through the platform
- **< 5 second** agent-to-notification latency
- **Zero security incidents** from git operation sandboxing
- **At least 3 organic posts** from OpenClaw community about using it

---

## 7. What Comes After the MVP

Once the core loop is validated (agents push, humans review), the roadmap opens up:

1. **Codebase understanding** — Semantic indexing of repos so agents (and humans) can ask questions about the code
2. **Multi-agent collaboration** — Multiple agents working on the same repo with conflict detection
3. **CI/CD integration** — Auto-run tests on agent changes, block merge on failure
4. **Agent marketplace** — Pre-configured agents for common tasks (dependency updates, security fixes, refactoring)
5. **GitHub import** — One-click migration from GitHub repos
6. **Team features** — Org management, shared agent pools, role-based access
7. **Self-hosted option** — For enterprises who want to run it on-prem
