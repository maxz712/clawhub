# AI-Native GitHub — Technical Architecture & Build Plan

## Product Name TBD — Working Title: "ClawForge"

---

## 1. Core Concept

A code hosting and collaboration platform where AI agents (starting with OpenClaw) are first-class citizens. Humans supervise, approve, and direct — agents do the work. Full git compatibility via Smart HTTP protocol, but the interaction layer is designed for agents and the supervision layer is designed for humans.

**Design Principle: Don't fight git, extend it.** Standard git transport works for every client in the world. ClawForge layers agent-native metadata (intent, risk assessment, permissions, audit trail) on top via the API and CLI. Agents that want the rich experience use the ClawForge API/CLI. Agents that just know git still work — their pushes get automatically enriched.

---

## 2. Technical Architecture

### 2.1 System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           AGENT LAYER                               │
│                                                                     │
│  OpenClaw Skill ──→  Agent Gateway API  ←── Claude Code / Cursor    │
│  (MCP/WebSocket)      (REST + WebSocket)                            │
│                            │                                        │
│  OpenClaw Agent ──→  Git Smart HTTP  ←────── Any git client         │
│  (via git)            (clone/fetch/push)                            │
│                            │                                        │
│  OpenClaw Agent ──→  ClawForge CLI  ←──────── Human developer       │
│  (review flow)        (wraps git + API)                             │
└────────────────────────────┼────────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────────┐
│                       CORE PLATFORM                                 │
│                            ▼                                        │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Git Smart   │  │ Change       │  │ Review   │  │ Permission │  │
│  │ HTTP Server │  │ Service      │  │ Service  │  │ & Identity │  │
│  │             │  │              │  │          │  │ Service    │  │
│  │ - info/refs │  │ - Create     │  │ - Submit │  │            │  │
│  │ - upload-   │  │ - Classify   │  │ - List   │  │ - Agent    │  │
│  │   pack      │  │ - Merge      │  │ - Agg.   │  │   scoping  │  │
│  │ - receive-  │  │ - Rollback   │  │ - Resolve│  │ - Path     │  │
│  │   pack      │  │ - Ref mgmt   │  │          │  │   rules    │  │
│  │ - post-     │  │              │  │          │  │ - Approval │  │
│  │   receive   │  │              │  │          │  │   gates    │  │
│  │   hooks     │  │              │  │          │  │ - Audit    │  │
│  └──────┬──────┘  └──────┬───────┘  └────┬─────┘  └─────┬──────┘  │
│         │                │               │               │         │
│         └────────┬───────┴───────────────┴───────────────┘         │
│                  ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Intent Engine                             │    │
│  │  - Parse intent from API submissions or commit messages     │    │
│  │  - Classify risk via LLM (Claude Sonnet)                    │    │
│  │  - Generate human-readable summaries                        │    │
│  │  - Route: auto-merge or queue for human review              │    │
│  └─────────────────────────┬───────────────────────────────────┘    │
│                             │                                       │
│  ┌─────────────────────────┼───────────────────────────────────┐    │
│  │                    Event Bus (Redis Streams)                 │    │
│  │  change.created | change.reviewed | change.merged | ...     │    │
│  └─────────────────────────┬───────────────────────────────────┘    │
│                             │                                       │
│  ┌─────────────────────────┼───────────────────────────────────┐    │
│  │                 Bare Git Repos (on disk)                     │    │
│  │                                                              │    │
│  │  refs/heads/*              (branches)                        │    │
│  │  refs/changes/*/head       (change branch HEADs)             │    │
│  │  refs/changes/*/merge      (trial merges with default branch)│    │
│  └──────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────────┐
│                            ▼    HUMAN LAYER                         │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │            Supervision Dashboard (Next.js)                │       │
│  │                                                           │       │
│  │  - Activity feed (real-time agent actions)                │       │
│  │  - Intent-based change review with inline comments        │       │
│  │  - One-click approve / reject / rollback                  │       │
│  │  - Agent management & permissions                         │       │
│  │  - Repo explorer with file tree, diff viewer, git history │       │
│  │  - Clone URL display, merge conflict indicators           │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │  ClawForge CLI (@clawforge/cli)                           │       │
│  │                                                           │       │
│  │  - clawforge clone (with sparse/shallow agent support)    │       │
│  │  - clawforge change list / show / checkout / diff         │       │
│  │  - clawforge change review --approve / --reject           │       │
│  │  - clawforge change merge                                 │       │
│  │  - clawforge agent list / log / scope                     │       │
│  │  - clawforge ask (query the codebase)                     │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │  Notification Layer                                       │       │
│  │  (Telegram, Slack, Email, OpenClaw channel-back)          │       │
│  └──────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
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
  is_public       boolean       controls anonymous read access
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
  has_conflicts   boolean       true if trial merge failed
  diff_summary    jsonb         files changed, lines added/removed
  semantic_diff   jsonb         structured description of behavioral changes
  source          enum          api | git_push       how the change was submitted
  created_at      timestamp
  reviewed_at     timestamp
  reviewed_by     UUID          → User (nullable)

Review
  id              UUID
  change_id       UUID          → Change
  reviewer_id     UUID          → Agent or User
  reviewer_type   enum          agent | human
  verdict         enum          approve | request_changes | comment
  summary         text          overall assessment
  comments        jsonb         [{path, line?, body}]
  created_at      timestamp

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
  action          string        "git_clone", "git_fetch", "git_push",
                                "change_created", "change_merged",
                                "review_submitted"
  metadata        jsonb         user agent, IP, files touched, etc.
  timestamp       timestamp
```

---

## 3. Git Smart HTTP Server

The foundation of the platform. Proxies to git's built-in `git-http-backend` CGI binary — this gives full protocol support (v1 and v2) for clone, fetch, push, shallow clones, partial clones, and sparse checkout without reimplementing the pack protocol.

### 3.1 Endpoints

```
# Ref discovery (used by git clone, git fetch, git push)
GET  /:owner/:repo.git/info/refs?service=git-upload-pack
GET  /:owner/:repo.git/info/refs?service=git-receive-pack

# Pack negotiation (actual data transfer)
POST /:owner/:repo.git/git-upload-pack       # clone / fetch
POST /:owner/:repo.git/git-receive-pack      # push
```

### 3.2 Implementation

```typescript
// packages/api/src/routes/git-http.ts
// Proxy requests to git-http-backend as CGI

const GIT_HTTP_BACKEND = '/usr/lib/git-core/git-http-backend';

export function gitSmartHttp(app: Hono) {

  // Ref discovery
  app.get('/:owner/:repo.git/info/refs', async (c) => {
    const service = c.req.query('service');
    if (!['git-upload-pack', 'git-receive-pack'].includes(service)) {
      return c.text('Invalid service', 403);
    }

    const agent = await authenticateRequest(c); // nullable for public repos
    const repo = await resolveRepo(c.req.param('owner'), c.req.param('repo'));
    if (!repo) return c.text('Not found', 404);

    // Push requires auth + permission
    if (service === 'git-receive-pack') {
      if (!agent) return c.text('Auth required', 401);
      if (!await checkPermission(agent, repo, 'push')) return c.text('Forbidden', 403);
    }

    // Read requires auth for private repos
    if (!repo.isPublic && !agent) return c.text('Auth required', 401);

    return proxyToGitBackend({
      GIT_PROJECT_ROOT: getRepoStoragePath(),
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${repo.gitPath}`,
      QUERY_STRING: `service=${service}`,
      REQUEST_METHOD: 'GET',
      GIT_PROTOCOL: c.req.header('Git-Protocol') || '',
    });
  });

  // Clone / fetch (upload-pack)
  app.post('/:owner/:repo.git/git-upload-pack', async (c) => {
    const repo = await resolveRepo(c.req.param('owner'), c.req.param('repo'));
    const agent = await authenticateRequest(c);

    if (!repo.isPublic && !agent) return c.text('Auth required', 401);

    // Audit the clone/fetch
    await logAuditEvent({
      repoId: repo.id,
      agentId: agent?.id,
      action: 'git_fetch',
      metadata: { userAgent: c.req.header('User-Agent') }
    });

    return proxyToGitBackend({
      GIT_PROJECT_ROOT: getRepoStoragePath(),
      PATH_INFO: `/${repo.gitPath}`,
      REQUEST_METHOD: 'POST',
      CONTENT_TYPE: 'application/x-git-upload-pack-request',
      GIT_PROTOCOL: c.req.header('Git-Protocol') || '',
    }, await c.req.arrayBuffer());
  });

  // Push (receive-pack)
  app.post('/:owner/:repo.git/git-receive-pack', async (c) => {
    const repo = await resolveRepo(c.req.param('owner'), c.req.param('repo'));
    const agent = await authenticateRequest(c);

    if (!agent) return c.text('Auth required', 401);
    if (!await checkPermission(agent, repo, 'push')) return c.text('Forbidden', 403);

    const response = await proxyToGitBackend({
      GIT_PROJECT_ROOT: getRepoStoragePath(),
      PATH_INFO: `/${repo.gitPath}`,
      REQUEST_METHOD: 'POST',
      CONTENT_TYPE: 'application/x-git-receive-pack-request',
      GIT_PROTOCOL: c.req.header('Git-Protocol') || '',
    }, await c.req.arrayBuffer());

    // Post-receive: create Change records from pushed branches
    processIncomingPush(repo, agent).catch(console.error);

    return response;
  });
}

// Spawn git-http-backend as CGI process
async function proxyToGitBackend(
  env: Record<string, string>,
  body?: ArrayBuffer
): Promise<Response> {
  return new Promise((resolve) => {
    const proc = spawn(GIT_HTTP_BACKEND, [], {
      env: { ...process.env, ...env },
    });

    if (body) {
      proc.stdin.write(Buffer.from(body));
      proc.stdin.end();
    }

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk) => chunks.push(chunk));

    proc.on('close', () => {
      const output = Buffer.concat(chunks);
      // Parse CGI response: headers separated from body by \r\n\r\n
      const headerEnd = output.indexOf('\r\n\r\n');
      const headerStr = output.slice(0, headerEnd).toString();
      const responseBody = output.slice(headerEnd + 4);

      const headers = new Headers();
      for (const line of headerStr.split('\r\n')) {
        const [key, ...vals] = line.split(': ');
        headers.set(key, vals.join(': '));
      }

      resolve(new Response(responseBody, { status: 200, headers }));
    });
  });
}
```

### 3.3 Auth for Git Operations

Git Smart HTTP uses standard HTTP auth. Two mechanisms supported:

```bash
# Token in URL (agents and CLI)
git clone https://agent-token:cf_abc123@clawforge.dev/user/repo.git

# Bearer header (for programmatic clients)
Authorization: Bearer cf_abc123

# Public repos allow anonymous read (git-upload-pack) with no auth
```

### 3.4 Large Repo Support

The git-http-backend proxy supports all of git's large repo features natively:

| Feature | Git Flag | What It Does | Agent Use Case |
|---------|----------|--------------|----------------|
| Shallow clone | `--depth N` | Only fetch N commits | Agent only needs current state |
| Partial clone (blobless) | `--filter=blob:none` | Lazy-load file contents | Agent exploring structure first |
| Partial clone (treeless) | `--filter=tree:0` | Only commit graph, lazy-load all | Known file path in monorepo |
| Sparse checkout | `--sparse` + `set` | Only populate specific dirs | Agent scoped to a module |
| Single branch | `--single-branch` | Fetch one branch only | Agent working on main only |

The ClawForge CLI wraps these into agent-friendly commands:

```bash
# Agent-friendly: clone only what you need
clawforge clone user/repo --scope "src/auth/**" --depth 1

# Under the hood:
# git clone --filter=blob:none --sparse --depth 1 https://...
# git sparse-checkout init --cone
# git sparse-checkout set src/auth
```

### 3.5 File API (Git-Free Access)

For agents that don't want to use git at all, a REST API for reading files:

```
GET /api/v1/repos/:id/tree/:branch              # list files/dirs at path
GET /api/v1/repos/:id/file/:branch/*path         # single file content
GET /api/v1/repos/:id/files/:branch              # batch file content
    ?paths=src/auth/login.ts,src/auth/oauth.ts
```

### 3.6 Post-Push Hook: Git Push → Change Record

When agents or humans push via standard git (instead of the agent API), the
post-receive hook bridges the push into ClawForge's Change system:

```typescript
// packages/api/src/services/post-receive.ts

async function processIncomingPush(repo: Repository, agent?: Agent) {
  const updatedRefs = await getUpdatedRefs(repo);

  for (const ref of updatedRefs) {
    if (ref.name === repo.defaultBranch) continue; // skip direct-to-main

    const commits = await getNewCommits(repo, ref.name);
    const diff = await getDiff(repo, repo.defaultBranch, ref.name);

    // Try structured commit messages first, fall back to LLM
    const structured = parseConventionalCommits(commits);
    let intent: string, description: string;

    if (structured) {
      intent = structured.summary;
      description = structured.details;
    } else {
      const llm = await classifyChange(commits, diff);
      intent = llm.intent;
      description = llm.description;
    }

    const change = await createChange({
      repoId: repo.id,
      agentId: agent?.id,
      intent,
      description,
      status: 'pending',
      branch: ref.name,
      source: 'git_push',
      riskLevel: await assessRisk(repo, ref.name),
      diffSummary: await getDiffSummary(repo, repo.defaultBranch, ref.name),
    });

    // Publish change refs for local checkout
    await publishChangeRefs(repo, change);

    await emitEvent('change.created', { repoId: repo.id, changeId: change.id });
  }
}
```

---

## 4. Change Refs & Local Review

### 4.1 How It Works

Every Change is published as a git ref, mirroring the pattern GitHub uses
for Pull Requests (`refs/pull/*/head`). This lets anyone fetch and checkout
a change locally using standard git.

```
refs/changes/<change-id>/head      → the change branch HEAD
refs/changes/<change-id>/merge     → trial merge with default branch
```

### 4.2 Ref Publishing

```typescript
// packages/api/src/services/change-refs.ts

async function publishChangeRefs(repo: Repository, change: Change) {
  const bareRepoPath = getFullRepoPath(repo);

  // Point refs/changes/<id>/head at the change branch
  await exec(
    `git -C ${bareRepoPath} update-ref refs/changes/${change.id}/head refs/heads/${change.branch}`
  );

  // Create a trial merge to detect conflicts
  try {
    const mergeTree = await exec(
      `git -C ${bareRepoPath} merge-tree --write-tree ` +
      `refs/heads/${repo.defaultBranch} refs/heads/${change.branch}`
    );
    const mergeCommit = await exec(
      `git -C ${bareRepoPath} commit-tree ${mergeTree.stdout.trim()} ` +
      `-p refs/heads/${repo.defaultBranch} -p refs/heads/${change.branch} ` +
      `-m "Trial merge for change ${change.id}"`
    );
    await exec(
      `git -C ${bareRepoPath} update-ref refs/changes/${change.id}/merge ${mergeCommit.stdout.trim()}`
    );
  } catch {
    await updateChange(change.id, { hasConflicts: true });
  }
}
```

### 4.3 Fetching Changes Locally

```bash
# Fetch a single change
git fetch origin refs/changes/abc123/head:changes/abc123
git checkout changes/abc123

# Fetch the trial merge version (change as-if-merged into main)
git fetch origin refs/changes/abc123/merge:changes/abc123-merged

# Auto-fetch ALL changes (add to .git/config):
# [remote "origin"]
#   fetch = +refs/changes/*/head:refs/remotes/origin/changes/*
```

### 4.4 Review API

Both the dashboard, CLI, and agents submit reviews through the same API:

```
POST /api/v1/repos/:id/changes/:changeId/reviews
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "Overall assessment",
  "comments": [
    { "path": "src/auth/login.ts", "line": 42, "body": "Doesn't handle expired tokens" }
  ]
}

GET  /api/v1/repos/:id/changes/:changeId/reviews
```

### 4.5 Agent-to-Agent Review Flow

An OpenClaw agent reviews another agent's change:

```
Human (via Telegram): "Review the latest changes on myrepo"

OpenClaw Agent:
  1. clawforge change list --repo user/myrepo --status pending
  2. For each pending change:
     a. clawforge change checkout <id>        # fetch + checkout locally
     b. Read changed files, run tests
     c. Analyze diff against codebase
     d. POST /api/v1/repos/:id/changes/:id/reviews
        { "verdict": "approve", "summary": "Looks good, tests pass" }
  3. Reports back to human
```

---

## 5. Agent Gateway API

The primary interface for agents interacting with ClawForge programmatically.

### 5.1 Endpoints

```
# Repository management
POST   /api/v1/repos                              Create repository
GET    /api/v1/repos/:id                           Get repo info + codebase summary
DELETE /api/v1/repos/:id                           Delete repository

# File access (git-free)
GET    /api/v1/repos/:id/tree/:branch              List files/dirs
GET    /api/v1/repos/:id/file/:branch/*path         Get file content
GET    /api/v1/repos/:id/files/:branch              Batch get files (?paths=...)

# Changes (the core workflow)
POST   /api/v1/repos/:id/changes                   Submit a change (with intent)
GET    /api/v1/repos/:id/changes                    List changes (?status=pending)
GET    /api/v1/repos/:id/changes/:changeId          Get change details
POST   /api/v1/repos/:id/changes/:changeId/merge    Merge an approved change
POST   /api/v1/repos/:id/changes/:changeId/rollback Rollback a merged change

# Reviews
POST   /api/v1/repos/:id/changes/:changeId/reviews  Submit review
GET    /api/v1/repos/:id/changes/:changeId/reviews   List reviews

# Agent management
POST   /api/v1/agents                              Register agent
GET    /api/v1/agents/:id                           Get agent info
GET    /api/v1/agents/:id/activity                  Agent activity log
PUT    /api/v1/agents/:id/permissions               Update permissions

# Codebase queries
POST   /api/v1/repos/:id/ask                       Ask a question about the codebase
```

### 5.2 Example: Agent Submits a Change

```json
POST /api/v1/repos/abc123/changes
Authorization: Bearer <agent-token>

{
  "intent": "Fix the stale cache bug reported in issue #42",
  "description": "The profile update endpoint was not invalidating the Redis cache.
                  Added cache invalidation after successful DB write. Also added a test.",
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
    "reasoning": "Small, targeted change. Only affects profile update path. Test added."
  }
}
```

---

## 6. ClawForge CLI

The CLI wraps git and the ClawForge API into a single tool for both humans and agents.

### 6.1 Installation & Auth

```bash
npm install -g @clawforge/cli
# or
brew install clawforge

clawforge auth login                    # browser OAuth for humans
clawforge auth token <token>            # direct token for agents
```

### 6.2 Commands

```bash
# ── Clone & Setup ──
clawforge clone <owner/repo>                  # clone with change refs configured
clawforge clone <owner/repo> --scope "src/"   # sparse clone (agent-optimized)
clawforge clone <owner/repo> --shallow        # shallow clone (--depth 1)

# ── Working with Changes ──
clawforge change list                         # list pending changes
clawforge change show <id>                    # show intent, risk, files, reviews
clawforge change checkout <id>                # fetch refs + checkout locally
clawforge change diff <id>                    # diff against default branch
clawforge change review <id> --approve        # approve from CLI
clawforge change review <id> --reject "why"   # reject with reason
clawforge change merge <id>                   # merge an approved change

# ── Creating Changes ──
clawforge change create \
  --intent "Fix stale cache bug" \
  --branch fix/cache-bug                      # wraps git push + Change creation

# ── Repo Interaction ──
clawforge ask "How does auth work here?"      # query the codebase
clawforge tree                                # file tree listing
clawforge cat src/auth/login.ts               # view a file

# ── Agent Management ──
clawforge agent list                          # list connected agents
clawforge agent log <agent-id>                # view agent activity
clawforge agent scope <agent-id> "src/**"     # restrict agent to a path
```

### 6.3 What `clawforge change checkout` Does

```typescript
export async function changeCheckout(changeId: string) {
  const change = await api.getChange(changeId);

  console.log(`Change: ${change.intent}`);
  console.log(`Agent:  ${change.agent?.name || 'human'}`);
  console.log(`Risk:   ${change.riskLevel}`);
  console.log(`Files:  ${change.diffSummary.filesChanged} changed`);

  // Fetch the change ref
  await exec(`git fetch origin refs/changes/${changeId}/head:changes/${changeId}`);

  // Also fetch trial merge if available
  try {
    await exec(`git fetch origin refs/changes/${changeId}/merge:changes/${changeId}-merged`);
    console.log(`Fetched trial merge: changes/${changeId}-merged`);
  } catch {
    console.log(`Note: trial merge unavailable (may have conflicts)`);
  }

  await exec(`git checkout changes/${changeId}`);

  console.log(`\nNow on change ${changeId}`);
  console.log(`  Diff:     clawforge change diff ${changeId}`);
  console.log(`  Approve:  clawforge change review ${changeId} --approve`);
  console.log(`  Merged:   git checkout changes/${changeId}-merged`);
  console.log(`  Go back:  git checkout ${change.repo.defaultBranch}`);
}
```

---

## 7. OpenClaw Skill

The adoption driver. Dead-simple skill installation that connects an OpenClaw agent to ClawForge.

### 7.1 Skill Definition

```yaml
name: clawforge
description: Push code, review changes, and manage repos on ClawForge
tools:
  - name: clawforge_clone
    description: Clone a ClawForge repository (supports sparse/shallow)
    parameters:
      repo: string
      scope: string?      # glob pattern for sparse checkout
      shallow: boolean?

  - name: clawforge_push
    description: Submit a code change with intent to a ClawForge repository
    parameters:
      repo: string
      intent: string
      files: array

  - name: clawforge_status
    description: Check status of changes on a repository
    parameters:
      repo: string
      status: string?     # pending | approved | merged

  - name: clawforge_review
    description: Review a pending change (approve, reject, or comment)
    parameters:
      change_id: string
      verdict: string     # approve | request_changes | comment
      summary: string
      comments: array?

  - name: clawforge_ask
    description: Ask a question about a codebase on ClawForge
    parameters:
      repo: string
      question: string

  - name: clawforge_read
    description: Read files from a ClawForge repository without cloning
    parameters:
      repo: string
      paths: array        # file paths to read
```

---

## 8. Tech Stack (MVP)

```
Backend:        TypeScript / Node.js (Hono)
Database:       PostgreSQL 16 + pgvector (for codebase semantic search later)
Git storage:    Bare git repos on disk, served via git-http-backend CGI
Event bus:      Redis 7 Streams (falls back to console logging when Redis unavailable)
Auth:           JWT tokens for agents, GitHub OAuth for humans
Frontend:       Next.js 16 + React 19 + Tailwind CSS 4 + shadcn/ui (supervision dashboard)
CLI:            TypeScript, commander.js + chalk, published as @clawforge/cli
Skill:          OpenClaw skill with MCP-compatible tool definitions (@clawforge/openclaw-skill)
Hosting:        Single VPS to start (Hetzner/Railway), Docker Compose
CI:             GitHub Actions for the platform itself
```

Docker image requirements: `git` (with `git-http-backend`), Node.js 20+, PostgreSQL client libs.

---

## 9. Build Plan — 6 Weeks

### Week 1: Foundation + Git Server

**Goal: A working git server that agents and humans can clone from and push to.**

Tasks:
- Set up TypeScript monorepo (npm workspaces): api, dashboard, cli, openclaw-skill
- Docker Compose: app + PostgreSQL 16 + Redis 7 (ensure `git` + `git-http-backend` in image)
- Database schema via Drizzle ORM (all tables from Section 2.2)
- Bare git repo creation and storage management
- **Git Smart HTTP endpoints**: info/refs, git-upload-pack, git-receive-pack (proxy to git-http-backend)
- Auth middleware: JWT token generation/validation, Basic auth for git operations
- File API: tree listing, single file, batch file read
- Test: `git clone`, `git push`, and `git fetch` work against a ClawForge repo

**Deliverable**: An agent can register, create a repo, clone it, push code, and read files via API.

### Week 2: Changes, Permissions, & Intent Engine

**Goal: Pushes create Change records, flow through permissions, and get queued for review.**

Tasks:
- Post-receive hook: detect branch pushes → create Change records
- Intent Engine: LLM wrapper (Claude Sonnet) for risk classification + summaries
- Conventional commit parsing as structured fallback
- Change ref publishing: refs/changes/<id>/head and /merge (trial merge generation)
- PermissionRule evaluation engine (glob matching, conditions)
- Change state machine: pending → approved/rejected → merged/rolled_back
- Auto-merge routing for low-risk changes matching rules
- Event emission to Redis Streams + audit event logging
- Review model + API endpoints (submit, list reviews on a change)

**Deliverable**: Agent pushes → system classifies risk → publishes change refs → routes to auto-merge or review queue.

### Week 3: Supervision Dashboard

**Goal: Humans can see agent activity, review changes, and manage permissions via web UI.**

Tasks:
- Next.js app with GitHub OAuth login
- Activity feed: real-time stream of agent actions across repos
- Change review view: intent, risk level, inline diff, review comments, conflict indicator
- Approve / reject / rollback buttons
- Agent management page: registered agents, activity log, edit permissions
- Repository pages: file browser, clone URL display, commit history, change list
- Settings: default permission rules, auto-merge policies

**Deliverable**: Human logs in, sees agents' work, reviews changes with full context, approves/rejects.

### Week 4: OpenClaw Skill + ClawForge CLI

**Goal: Full end-to-end loop — OpenClaw agent uses the platform, human reviews via CLI or dashboard.**

Tasks:
- **ClawForge CLI** (@clawforge/cli on npm):
  - Auth flow (login, token storage in ~/.clawforge/config.json)
  - `clone` (with --scope and --shallow flags for sparse/shallow)
  - `change list`, `change show`, `change checkout`, `change diff`
  - `change review --approve / --reject`
  - `change create`, `change merge`
  - `agent list`, `agent log`, `agent scope`
- **OpenClaw skill package**:
  - MCP-compatible tool definitions (clone, push, status, review, ask, read)
  - Skill installation docs + one-command setup
- End-to-end testing: OpenClaw agent → skill → API/git → change refs → CLI checkout → review → merge
- WebSocket notifications: push change status back to agent in real-time

**Deliverable**: Full loop works from both agent and human sides. OpenClaw user types a command, human reviews via CLI.

### Week 5: Polish + Integration

**Goal: Smooth out rough edges, handle edge cases, improve the review experience.**

Tasks:
- Notification hooks: Telegram/Slack/Email when changes need review
- Dashboard improvements: better diff viewer, side-by-side diffs, syntax highlighting
- CLI improvements: colored output, interactive mode, `clawforge ask` integration
- Error handling: LLM classification failures, git operation failures, conflict resolution UX
- Agent identity in git log (proper author attribution for agent commits)
- API docs / OpenAPI spec
- Rate limiting + request validation

**Deliverable**: Production-quality experience for the core clone → push → review → merge loop.

### Week 6: Launch Prep + Community

**Goal: Ship public beta to OpenClaw community.**

Tasks:
- Landing page explaining the concept + value prop
- Publish OpenClaw skill to ClawHub / skill directory
- Publish CLI to npm
- Setup guide targeting OpenClaw users
- Demo video: agent pushes code via OpenClaw → human reviews via CLI → merge
- Security audit: token management, git sandboxing, input validation
- Monitoring, error tracking, uptime alerting
- Soft launch: OpenClaw Discord, X, Hacker News

**Deliverable**: Public beta. OpenClaw users can sign up, connect agents, and start using ClawForge.

---

## 10. Agent Instructions for Code Agents

### 10.1 Repo Structure

```
clawforge/
├── packages/
│   ├── api/                          # Backend API service
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── agents.ts         # Agent CRUD
│   │   │   │   ├── repos.ts          # Repository CRUD + file API
│   │   │   │   ├── changes.ts        # Change submission, listing, merge
│   │   │   │   ├── reviews.ts        # Review submission, listing
│   │   │   │   └── git-http.ts       # Git Smart HTTP protocol proxy
│   │   │   ├── services/
│   │   │   │   ├── git.ts            # Bare git operations wrapper
│   │   │   │   ├── git-backend.ts    # git-http-backend CGI proxy
│   │   │   │   ├── intent.ts         # Intent engine (LLM classification)
│   │   │   │   ├── permissions.ts    # Permission rule evaluation
│   │   │   │   ├── changes.ts        # Change lifecycle management
│   │   │   │   ├── change-refs.ts    # Publish/cleanup refs/changes/*
│   │   │   │   ├── post-receive.ts   # Git push → Change record bridge
│   │   │   │   └── reviews.ts        # Review aggregation + resolution
│   │   │   ├── models/               # Drizzle ORM schema
│   │   │   ├── middleware/           # Auth, rate limiting, error handling
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── dashboard/                    # Next.js supervision UI
│   │   ├── app/
│   │   │   ├── dashboard/            # Activity feed
│   │   │   ├── repos/                # Repo list, file browser, settings
│   │   │   ├── changes/              # Change review UI
│   │   │   └── agents/               # Agent management
│   │   └── package.json
│   │
│   ├── cli/                          # ClawForge CLI
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── clone.ts
│   │   │   │   ├── change.ts         # list, show, checkout, diff, review, merge, create
│   │   │   │   ├── agent.ts          # list, log, scope
│   │   │   │   └── ask.ts
│   │   │   ├── lib/
│   │   │   │   ├── api-client.ts     # ClawForge API wrapper
│   │   │   │   ├── config.ts         # ~/.clawforge/config.json management
│   │   │   │   └── git.ts            # Git operation helpers
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── bin/clawforge.js
│   │
│   └── openclaw-skill/               # OpenClaw skill package
│       ├── skill.yaml
│       ├── tools/
│       │   ├── clone.ts
│       │   ├── push.ts
│       │   ├── status.ts
│       │   ├── review.ts
│       │   ├── ask.ts
│       │   └── read.ts
│       └── README.md
│
├── docker-compose.yml
├── Dockerfile
├── .env.example
└── README.md
```

### 10.2 Key Prompts for Your Code Agent

**Prompt 1 — Project Bootstrap:**
> Set up a TypeScript monorepo called "clawforge" using npm workspaces. Four packages: api (Hono + Drizzle ORM + PostgreSQL), dashboard (Next.js 14 + Tailwind + shadcn/ui), cli (commander.js), and openclaw-skill. Include Docker Compose with PostgreSQL 16 and Redis 7. The Dockerfile should be based on node:20 and must install git (including git-http-backend at /usr/lib/git-core/git-http-backend). The API should have health check and basic error handling middleware.

**Prompt 2 — Database Schema:**
> Using Drizzle ORM, create the schema for: agents (id uuid, name, type enum [openclaw/claude_code/cursor/generic], owner_id → users, public_key, metadata jsonb, created_at), users (id uuid, email, auth_provider enum, created_at), repositories (id uuid, name, owner_id → users, git_path, description, default_branch, is_public boolean, created_at), changes (id uuid, repo_id → repos, agent_id → agents nullable, intent text, description text, status enum [pending/approved/rejected/merged/rolled_back], risk_level enum [low/medium/high/critical], branch, has_conflicts boolean default false, diff_summary jsonb, semantic_diff jsonb, source enum [api/git_push], created_at, reviewed_at, reviewed_by → users nullable), reviews (id uuid, change_id → changes, reviewer_id uuid, reviewer_type enum [agent/human], verdict enum [approve/request_changes/comment], summary text, comments jsonb, created_at), permission_rules (id uuid, repo_id → repos, agent_id → agents nullable, rule_type enum, pattern, conditions jsonb), audit_events (id uuid, repo_id, agent_id, action, metadata jsonb, timestamp). Add proper indexes and foreign keys.

**Prompt 3 — Git Smart HTTP Server:**
> Implement Git Smart HTTP protocol support in our Hono API server. Create packages/api/src/routes/git-http.ts handling: GET /:owner/:repo.git/info/refs (with service query param), POST /:owner/:repo.git/git-upload-pack, POST /:owner/:repo.git/git-receive-pack. Proxy all requests to git-http-backend CGI at /usr/lib/git-core/git-http-backend by spawning it as a child process with correct CGI env vars (GIT_PROJECT_ROOT, PATH_INFO, QUERY_STRING, REQUEST_METHOD, CONTENT_TYPE, GIT_HTTP_EXPORT_ALL, GIT_PROTOCOL from Git-Protocol header). Parse CGI response to extract HTTP headers and body. Add auth middleware that checks Bearer tokens and Basic auth. For receive-pack, add post-receive processing that fires async after the response. Support protocol v2.

**Prompt 4 — Git Service + Change Refs:**
> Create packages/api/src/services/git.ts wrapping bare git operations: init bare repo, create branch, apply diffs, merge branch to main, get diff between branches, list files, get file contents, rollback merge. Create packages/api/src/services/change-refs.ts that when a Change is created: (1) creates ref at refs/changes/<changeId>/head pointing to the change branch, (2) attempts trial merge via `git merge-tree --write-tree` between default branch and change branch — if success, creates merge commit and refs/changes/<changeId>/merge; if failure, sets hasConflicts=true on Change, (3) cleans up refs when change is merged/rejected. Use child_process.exec for git commands.

**Prompt 5 — Post-Receive Processing:**
> Create packages/api/src/services/post-receive.ts. After a git push completes, detect which branches were updated (not default branch). For each updated branch: get new commits, get diff against default branch, try to parse conventional commit messages for structured intent. If not conventional, call Claude Sonnet API to classify the change and generate a summary. Create a Change record with source='git_push', call the change-refs service to publish refs, emit 'change.created' event to Redis Streams.

**Prompt 6 — ClawForge CLI:**
> Create packages/cli using commander.js. Commands: `auth login` (opens browser OAuth), `auth token <t>` (stores in ~/.clawforge/config.json), `clone <owner/repo>` (git clone with extra fetch refspec for refs/changes/*), `clone --scope <glob>` (git clone --filter=blob:none --sparse + sparse-checkout set), `change list` (GET changes API), `change show <id>`, `change checkout <id>` (fetch refs/changes/<id>/head and /merge, checkout head, print info), `change diff <id>` (git diff default..change), `change review <id> --approve|--reject <reason>` (POST review), `change merge <id>` (POST merge). Store API URL and token in ~/.clawforge/config.json. Publish as @clawforge/cli on npm with bin entry.

---

## 11. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Git operation security (arbitrary code via diffs) | Critical | Sandbox git ops in container, validate diffs, no executable perms, chroot git storage |
| Agent token compromise | High | Short-lived tokens, scope to specific repos, revocation endpoint, audit trail |
| git-http-backend CGI overhead | Medium | Process pooling, consider Gitaly/libgit2 at scale |
| LLM intent classification unreliable | Medium | Fallback to manual classification, humans override, log accuracy for tuning |
| OpenClaw API/skill format changes | Medium | Abstract skill interface, version the API, watch OpenClaw releases |
| Low adoption | High | Ship OpenClaw skill early, optimize for that community, demo video, Discord presence |
| Git storage costs at scale | Medium | Start on disk, migrate to object storage + packfile optimization later |
| Change ref namespace pollution | Low | TTL-based cleanup of merged/rejected change refs |

---

## 12. Success Metrics (First 90 Days)

- **10+ OpenClaw agents connected** in the first 2 weeks post-launch
- **100+ changes processed** through the platform (via API and git push combined)
- **50+ changes reviewed** via CLI or dashboard
- **< 5 second** agent-to-notification latency
- **< 3 second** clone time for repos under 100MB
- **Zero security incidents** from git operation sandboxing
- **At least 3 organic posts** from OpenClaw community about using it

---

## 13. What Comes After the MVP

Once the core loop is validated (agents clone → push → humans review locally → merge):

1. **Codebase understanding** — Semantic indexing with pgvector so agents and humans can ask questions about the code
2. **Multi-agent collaboration** — Multiple agents on same repo with conflict detection and resolution
3. **CI/CD integration** — Auto-run tests on agent changes, block merge on failure
4. **Agent marketplace** — Pre-configured agents for common tasks (deps, security fixes, refactoring)
5. **GitHub import** — One-click migration from GitHub repos (clone + reconstruct PR history as Changes)
6. **GitHub mirror** — Push to both ClawForge and GitHub for teams transitioning gradually
7. **Team features** — Org management, shared agent pools, role-based access
8. **Self-hosted option** — Docker image for enterprises running on-prem
9. **Forking & cross-repo agents** — Agents that contribute to repos they don't own
10. **Billing & usage** — Metered by storage, compute (LLM calls), and agent seats