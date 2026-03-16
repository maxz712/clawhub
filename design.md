# AI-Native GitHub — Technical Architecture & Build Plan

## Product Name TBD — Working Title: "ClawForge"

---

## 1. Core Concept

A code hosting platform where AI agents are first-class citizens. Everything is git. Agents clone, branch, commit, and push exactly as they already do. ClawForge's value is in what happens *after* the push: parsing agent-provided metadata from commits, presenting it in a rich review experience, and giving humans the tools to supervise agent work efficiently.

**Design Principle: Everything is git.** Agents already know git. We don't add a parallel API for submitting code. Instead, we define a lightweight metadata convention that agents include in their commits. ClawForge parses this metadata and wraps it into a better UI, API, and CLI for the humans reviewing the work. Wherever git doesn't have a feature we need, we ask agents to provide the information themselves (in commits) and we surface it for users.

**What ClawForge adds on top of git:**
- A metadata convention (git trailers) that agents include in commits
- A focused review experience where agents highlight the exact lines reviewers should look at
- A review experience (web dashboard + CLI) that parses and displays that metadata
- Change refs (`refs/changes/*`) so reviewers can easily fetch and checkout agent work
- Agent identity, permissions, and audit trail
- Trial merge detection (conflict warnings before review)
- Auto-repo creation: agents can push to a new URL and the repo is created automatically
- Configurable merge policies: agent-only approvals can be sufficient based on repo settings

**What ClawForge does NOT do:**
- Replace git with a custom submission API
- Run an LLM to guess what the agent was trying to do (the agent tells us)
- Force agents to learn a new protocol

---

## 2. The Metadata Convention

Agents include structured metadata in their commit messages using **git trailers** — a standard git feature. This is the contract between agents and ClawForge.

### 2.1 Format

```
<short summary of the change>

<longer description of what was done and why>

Intent: <what the agent was trying to accomplish>
Risk: <low|medium|high|critical>
Scope: <comma-separated list of affected areas>
Review-Focus: <filepath:lines — what to look at and why>
Refs: <issue numbers, ticket IDs, or related context>
Agent: <agent name and type>
```

### 2.2 Example: Agent Commit

```
Fix stale profile cache after updates

The profile update endpoint was not invalidating the Redis cache key
after writing to the database. Users were seeing stale data for up to
5 minutes after updating their profile. Added cache.invalidate() call
after successful DB write. Added integration test for this path.

Intent: Fix stale cache bug where profile updates weren't visible immediately
Risk: low
Scope: src/api/profile.ts, tests/api/profile.test.ts
Review-Focus: src/api/profile.ts:47-52 — the new cache invalidation logic
Review-Focus: src/api/profile.ts:89 — changed return type, check frontend contract
Refs: issue #42
Agent: felix-openclaw (openclaw)
```

Agents can also add inline review guidance directly in the code using `// REVIEW:` comments. These are real code comments that also serve as review hints — ClawForge scans the diff for added lines matching this prefix and highlights them in the review UI:

```typescript
// In the actual code the agent writes:
// REVIEW: This is the critical change — invalidating cache after DB write.
// Previously there was no invalidation, causing 5min stale data.
await cache.invalidate(`profile:${userId}`);

// REVIEW: Changed return type — check this doesn't break the frontend contract
return { profile: updated, cacheInvalidated: true };
```

### 2.3 Example: Multi-Commit Branch

For larger changes spanning multiple commits, agents include a summary trailer on the final commit or on a merge commit:

```
Add OAuth2 support to auth module

Implements OAuth2 authorization code flow with PKCE. Adds Google and
GitHub as identity providers. Refactors the existing session management
to support both password and OAuth login methods. Includes migration
for the new oauth_connections table.

Intent: Add OAuth2 login support (Google + GitHub) as requested by user
Risk: high
Scope: src/auth/*, src/db/migrations/*, src/api/login.ts
Refs: feature-request #18
Agent: felix-openclaw (openclaw)
Files-Changed: 12
Tests-Added: 8
```

### 2.4 Parsing Rules

ClawForge parses git trailers using `git log --format='%(trailers)'`. The convention is:

| Trailer | Required | Description |
|---------|----------|-------------|
| `Intent` | Yes | What the agent was trying to accomplish (shown prominently in review UI) |
| `Risk` | No | Agent's self-assessment: low, medium, high, critical. Defaults to "medium" if missing. |
| `Scope` | No | Affected areas. If missing, derived from the diff. |
| `Review-Focus` | No | File and line ranges the reviewer should focus on, with explanation. Multiple allowed. Format: `filepath:lines — description`. |
| `Refs` | No | Related issues, tickets, or context links |
| `Agent` | No | Agent name and type. If missing, inferred from git author/committer. |

In addition to the `Review-Focus` trailer, agents can add `// REVIEW:` comments directly in code (using the language's comment syntax: `# REVIEW:` for Python, `-- REVIEW:` for SQL, etc.). ClawForge scans added lines in the diff for this prefix and surfaces them as focus highlights in the review UI. These comments are also visible when reading the code raw — they're not metadata that disappears outside ClawForge.

If a commit has no trailers at all, ClawForge still works — it just falls back to the commit message as the intent and derives everything from the diff. The trailers make the experience better, not mandatory. This means human developers can also push without trailers and everything still works.

### 2.5 What Agents Need to Do

Nothing new. They already write commit messages. We're just asking them to be slightly more structured about it. An OpenClaw skill or prompt addition like this is all it takes:

```
When committing code to a ClawForge repository, include these git trailers
at the end of your commit message:

Intent: <what you were trying to accomplish>
Risk: <low|medium|high|critical>
Scope: <key files or areas affected>
Review-Focus: <file:lines — what to look at and why> (one per focus area)

Also add // REVIEW: comments in the code at lines that need human attention.
These are real comments that also serve as review guidance.
```

This is a documentation/prompting change, not a code change. Any agent that can write a commit message can do this.

---

## 3. Technical Architecture

### 3.1 System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           AGENT LAYER                               │
│                     (everything is standard git)                    │
│                                                                     │
│  OpenClaw Agent ──→  git clone / fetch / push  ←── Claude Code     │
│  Cursor Agent   ──→  (Smart HTTP protocol)     ←── Devin           │
│  Any git client ──→                            ←── Human developer │
│                            │                                        │
│  Agents include metadata trailers in their commit messages.         │
│  No new protocol, no new API for submitting code.                   │
└────────────────────────────┼────────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────────┐
│                       CORE PLATFORM                                 │
│                            ▼                                        │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Git Smart   │  │ Change       │  │ Review   │  │ Permission │  │
│  │ HTTP Server │  │ Detection    │  │ Service  │  │ & Identity │  │
│  │             │  │              │  │          │  │ Service    │  │
│  │ - info/refs │  │ - Post-push  │  │ - Submit │  │            │  │
│  │ - upload-   │  │   branch     │  │ - List   │  │ - Agent    │  │
│  │   pack      │  │   detection  │  │ - Agg.   │  │   identity │  │
│  │ - receive-  │  │ - Trailer    │  │ - Resolve│  │ - Path     │  │
│  │   pack      │  │   parsing    │  │          │  │   rules    │  │
│  │             │  │ - Ref        │  │          │  │ - Approval │  │
│  │             │  │   publishing │  │          │  │   gates    │  │
│  │             │  │ - Trial      │  │          │  │ - Audit    │  │
│  │             │  │   merge      │  │          │  │   trail    │  │
│  └──────┬──────┘  └──────┬───────┘  └────┬─────┘  └─────┬──────┘  │
│         │                │               │               │         │
│         └────────┬───────┴───────────────┴───────────────┘         │
│                  ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────┐    │
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
│  │  - Activity feed: what agents pushed, parsed from trailers│       │
│  │  - Change review: intent, risk, scope, inline diff        │       │
│  │  - Focused review: highlights from Review-Focus + REVIEW: │       │
│  │  - Review comments + approve / reject / rollback          │       │
│  │  - Agent activity: who pushed what, when, audit trail     │       │
│  │  - Repo explorer: file tree, commit history, clone URL    │       │
│  │  - Conflict indicators from trial merges                  │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │  ClawForge CLI (@clawforge/cli)                           │       │
│  │                                                           │       │
│  │  - clawforge clone (configures change ref fetching)       │       │
│  │  - clawforge change list / show / checkout / diff         │       │
│  │  - clawforge change diff --focused (agent-highlighted)    │       │
│  │  - clawforge change review --approve / --reject           │       │
│  │  - clawforge change merge                                 │       │
│  │  - clawforge log (parsed trailer view of git log)         │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │  Notification Layer                                       │       │
│  │  (Telegram, Slack, Email, OpenClaw channel-back)          │       │
│  └──────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Data Model

```
Agent
  id              UUID
  name            string        "felix-openclaw"
  type            enum          openclaw | claude_code | cursor | generic
  owner_id        UUID          → User
  git_author      string        the git author string this agent uses
                                (matched to identify agent commits)
  can_create_repos boolean      default true, can be disabled by owner
  created_at      timestamp
  metadata        jsonb         openclaw config, model info, etc.

User (Human)
  id              UUID
  email           string
  auth_provider   enum          github_oauth | email | api_key
  max_repos       int           repo limit (prevents runaway agent creation)
  created_at      timestamp

Repository
  id              UUID
  name            string
  owner_id        UUID          → User
  created_by      UUID          → Agent (nullable, null if created by human)
  git_path        string        bare repo path on disk
  description     text
  default_branch  string
  is_public       boolean       controls anonymous read access
  auto_create_repos boolean     allow agents to create repos under this owner (default true)
  merge_policy    jsonb         configurable merge approval rules (see Section 7.3)
  created_at      timestamp

Change (a branch with parsed metadata, replaces PR concept)
  id              UUID
  repo_id         UUID          → Repository
  agent_id        UUID          → Agent (nullable, could be human)
  branch          string        the branch name
  intent          text          parsed from Intent: trailer
  risk_level      enum          parsed from Risk: trailer (default: medium)
  scope           text[]        parsed from Scope: trailer (or derived from diff)
  review_focus    jsonb         parsed from Review-Focus: trailers
                                [{path, lines?, description}]
  review_comments jsonb         parsed from // REVIEW: inline comments in diff
                                [{path, line, body}]
  refs            text[]        parsed from Refs: trailer
  commit_count    int           number of commits on branch vs default
  has_conflicts   boolean       true if trial merge failed
  status          enum          pending | approved | rejected | merged | rolled_back
  created_at      timestamp
  updated_at      timestamp

Review
  id              UUID
  change_id       UUID          → Change
  reviewer_id     UUID          → Agent or User
  reviewer_type   enum          agent | human
  verdict         enum          approve | request_changes | comment
  summary         text
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
  metadata        jsonb
  timestamp       timestamp
```

---

## 4. Git Smart HTTP Server

Standard git hosting. Proxies to `git-http-backend` CGI — gives full protocol support for clone, fetch, push, partial/shallow/sparse clones.

### 4.1 Endpoints

```
GET  /:owner/:repo.git/info/refs?service=git-upload-pack     # ref discovery
GET  /:owner/:repo.git/info/refs?service=git-receive-pack    # ref discovery
POST /:owner/:repo.git/git-upload-pack                        # clone / fetch
POST /:owner/:repo.git/git-receive-pack                       # push
```

### 4.2 Implementation

Proxy to `git-http-backend` at `/usr/lib/git-core/git-http-backend` via CGI environment variables. Auth via Bearer token or Basic auth (token as password). Public repos allow anonymous reads. Push requires auth and permission check. After receive-pack completes, fire async post-push processing.

```typescript
// packages/api/src/routes/git-http.ts

app.post('/:owner/:repo.git/git-receive-pack', async (c) => {
  const repo = await resolveRepo(c.req.param('owner'), c.req.param('repo'));
  const identity = await authenticateGitRequest(c);
  if (!identity) return c.text('Auth required', 401);
  if (!await checkPushPermission(identity, repo)) return c.text('Forbidden', 403);

  const response = await proxyToGitBackend(/* ... */);

  // This is where the magic happens:
  // detect new/updated branches, parse trailers, create Change records
  detectAndProcessChanges(repo, identity).catch(console.error);

  return response;
});
```

### 4.3 Auth

```bash
# Token in URL (agents)
git clone https://x-token:cf_abc123@clawforge.dev/user/repo.git

# Or configure credential helper via CLI
clawforge auth login   # writes credential to git credential store

# Public repos: anonymous clone/fetch, auth required for push
```

### 4.4 Large Repo Support (Natively via git-http-backend)

All of git's large repo features work out of the box:

```bash
git clone --depth 1 https://clawforge.dev/user/repo.git                    # shallow
git clone --filter=blob:none https://clawforge.dev/user/repo.git           # blobless
git clone --filter=tree:0 https://clawforge.dev/user/repo.git              # treeless
git clone --filter=blob:none --sparse https://clawforge.dev/user/repo.git  # sparse
```

Agents already know how to use these. No ClawForge-specific flags needed.

### 4.5 Auto-Repo Creation on Push

When an authenticated agent pushes to a URL that doesn't exist yet, ClawForge creates the repo automatically — no dashboard step, no API call. This mirrors how Gitea handles repo creation and keeps the agent workflow frictionless.

```bash
# Agent just pushes to a new URL — repo gets created
git remote add origin https://clawforge.dev/alice/new-project.git
git push -u origin main
# ClawForge sees the push, checks alice's token, creates the bare repo, accepts the push
```

```typescript
// In git-http.ts — resolve or auto-create repo

async function resolveOrCreateRepo(owner: string, repoName: string, identity: Identity) {
  // 1. Try to find existing repo
  let repo = await db.repos.findByOwnerAndName(owner, repoName);
  if (repo) return repo;

  // 2. Check if auto-creation is allowed
  const user = await db.users.findByUsername(owner);
  if (!user) return null;

  // Agent must belong to this owner
  if (identity.type === 'agent' && identity.ownerId !== user.id) return null;

  // Check agent's can_create_repos flag
  if (identity.type === 'agent' && !identity.canCreateRepos) return null;

  // Check repo limit
  const repoCount = await db.repos.countByOwner(user.id);
  if (repoCount >= user.maxRepos) return null;

  // 3. Create the repo
  repo = await db.repos.create({
    name: repoName,
    ownerId: user.id,
    createdBy: identity.id,
    gitPath: `${owner}/${repoName}.git`,
    defaultBranch: 'main',
    isPublic: false,
    autoCreated: true,
  });

  // Init bare repo on disk
  await exec(`git init --bare ${getFullRepoPath(repo)}`);

  await logAuditEvent({
    repoId: repo.id,
    agentId: identity.type === 'agent' ? identity.id : null,
    action: 'repo_auto_created',
    metadata: { createdBy: identity.name },
  });

  return repo;
}
```

**Guardrails:**
- Repos are always created under the agent's owner account (`clawforge.dev/owner/repo`), never under the agent's own namespace
- Per-account repo limit (`max_repos` on User) prevents runaway creation
- `can_create_repos` flag on Agent can be disabled by the owner
- Auto-created repos inherit the owner's default permission rules and merge policy
- All auto-creations are logged in the audit trail

---

## 5. Post-Push Change Detection

The core of ClawForge's value. When a push comes in, we detect branches, parse trailers, and create Change records.

### 5.1 Flow

```
git push origin feature/fix-cache
        │
        ▼
  Git Smart HTTP (receive-pack)
        │
        ▼
  Post-push processing (async):
    1. Detect updated branches (not default branch)
    2. For each branch:
       a. Get commits on branch that aren't on default branch
       b. Parse git trailers from commit messages
       c. Match agent identity from git author or Agent: trailer
       d. Create or update a Change record
       e. Publish refs/changes/<id>/head and /merge (trial merge)
       f. Check permission rules → auto-merge or queue for review
       g. Emit event → notifications
```

### 5.2 Trailer Parsing

```typescript
// packages/api/src/services/trailer-parser.ts

interface ReviewFocusArea {
  path: string;
  lines: string | null;     // e.g. "47-52" or null
  description: string;
}

interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

interface ParsedMetadata {
  intent: string | null;
  risk: 'low' | 'medium' | 'high' | 'critical';
  scope: string[];
  reviewFocus: ReviewFocusArea[];
  refs: string[];
  agentName: string | null;
}

async function parseTrailersFromBranch(
  repoPath: string,
  branch: string,
  defaultBranch: string
): Promise<ParsedMetadata> {

  // Get trailers from all commits on the branch
  const { stdout } = await exec(
    `git -C ${repoPath} log ${defaultBranch}..${branch} --format='%(trailers:key=Intent,valueonly)|||%(trailers:key=Risk,valueonly)|||%(trailers:key=Scope,valueonly)|||%(trailers:key=Refs,valueonly)|||%(trailers:key=Agent,valueonly)'`
  );

  // Get all Review-Focus trailers (can be multiple per commit, multiple commits)
  const { stdout: focusRaw } = await exec(
    `git -C ${repoPath} log ${defaultBranch}..${branch} --format='%(trailers:key=Review-Focus,valueonly)'`
  );

  // Parse Review-Focus trailers
  const reviewFocus: ReviewFocusArea[] = focusRaw.trim().split('\n')
    .filter(Boolean)
    .map(line => {
      // Format: "src/api/profile.ts:47-52 — the new cache invalidation logic"
      const dashIndex = line.indexOf('—') !== -1 ? line.indexOf('—') : line.indexOf('-');
      const pathPart = dashIndex > 0 ? line.slice(0, dashIndex).trim() : line.trim();
      const description = dashIndex > 0 ? line.slice(dashIndex + 1).trim() : '';
      const colonIndex = pathPart.lastIndexOf(':');
      const hasLines = colonIndex > 0 && /^\d/.test(pathPart.slice(colonIndex + 1));
      return {
        path: hasLines ? pathPart.slice(0, colonIndex) : pathPart,
        lines: hasLines ? pathPart.slice(colonIndex + 1) : null,
        description,
      };
    });

  // Use the most recent commit's trailers (last commit is the summary)
  const lines = stdout.trim().split('\n').filter(Boolean);
  const latest = lines[0]; // most recent commit

  if (!latest || latest === '||||||||||||||||') {
    // No trailers found — fall back to commit message as intent
    const { stdout: msg } = await exec(
      `git -C ${repoPath} log ${defaultBranch}..${branch} --format='%s' -1`
    );
    return {
      intent: msg.trim() || null,
      risk: 'medium',
      scope: [],
      reviewFocus,
      refs: [],
      agentName: null,
    };
  }

  const [intent, risk, scope, refs, agent] = latest.split('|||');

  return {
    intent: intent?.trim() || null,
    risk: (['low','medium','high','critical'].includes(risk?.trim()))
      ? risk.trim() as any
      : 'medium',
    scope: scope?.trim() ? scope.split(',').map(s => s.trim()) : [],
    reviewFocus,
    refs: refs?.trim() ? refs.split(',').map(s => s.trim()) : [],
    agentName: agent?.trim() || null,
  };
}

// Scan diff for // REVIEW: inline comments
async function parseReviewComments(
  repoPath: string,
  branch: string,
  defaultBranch: string
): Promise<ReviewComment[]> {
  const { stdout: diff } = await exec(
    `git -C ${repoPath} diff ${defaultBranch}..${branch} --unified=0`
  );

  const comments: ReviewComment[] = [];
  let currentFile = '';
  let currentLine = 0;

  for (const line of diff.split('\n')) {
    // Track current file
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
    }
    // Track line numbers from hunk headers
    if (line.startsWith('@@')) {
      const match = line.match(/\+(\d+)/);
      if (match) currentLine = parseInt(match[1]) - 1;
    }
    // Count added lines
    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentLine++;
      // Check for REVIEW: pattern (any comment syntax)
      const reviewMatch = line.match(/^[+]\s*(?:\/\/|#|--|\/\*|\*)\s*REVIEW:\s*(.*)/);
      if (reviewMatch) {
        comments.push({
          path: currentFile,
          line: currentLine,
          body: reviewMatch[1].trim(),
        });
      }
    }
  }

  return comments;
}
```

### 5.3 Agent Identification

Agents are matched to Change records by git author string or the `Agent:` trailer:

```typescript
async function identifyAgent(
  repoPath: string, branch: string, defaultBranch: string, pusherId: string
): Promise<Agent | null> {

  // 1. Check Agent: trailer
  const metadata = await parseTrailersFromBranch(repoPath, branch, defaultBranch);
  if (metadata.agentName) {
    const agent = await db.agents.findByName(metadata.agentName);
    if (agent) return agent;
  }

  // 2. Check git author email
  const { stdout: authorEmail } = await exec(
    `git -C ${repoPath} log ${defaultBranch}..${branch} --format='%ae' -1`
  );
  const agent = await db.agents.findByGitAuthor(authorEmail.trim());
  if (agent) return agent;

  // 3. Fall back to the identity that authenticated the push
  return db.agents.findByOwnerId(pusherId);
}
```

---

## 6. Change Refs & Local Review

### 6.1 Ref Publishing

Every Change gets refs so reviewers can fetch and checkout locally:

```
refs/changes/<change-id>/head      → branch HEAD
refs/changes/<change-id>/merge     → trial merge with default branch
```

```typescript
async function publishChangeRefs(repo: Repository, change: Change) {
  const path = getFullRepoPath(repo);

  await exec(`git -C ${path} update-ref refs/changes/${change.id}/head refs/heads/${change.branch}`);

  // Trial merge
  try {
    const tree = await exec(
      `git -C ${path} merge-tree --write-tree refs/heads/${repo.defaultBranch} refs/heads/${change.branch}`
    );
    const commit = await exec(
      `git -C ${path} commit-tree ${tree.stdout.trim()} ` +
      `-p refs/heads/${repo.defaultBranch} -p refs/heads/${change.branch} ` +
      `-m "Trial merge for change ${change.id}"`
    );
    await exec(`git -C ${path} update-ref refs/changes/${change.id}/merge ${commit.stdout.trim()}`);
  } catch {
    await updateChange(change.id, { hasConflicts: true });
  }
}
```

### 6.2 Fetching Changes

```bash
# Single change
git fetch origin refs/changes/abc123/head:changes/abc123
git checkout changes/abc123

# All changes (configure once)
# In .git/config under [remote "origin"]:
#   fetch = +refs/changes/*/head:refs/remotes/origin/changes/*
git fetch origin
git checkout origin/changes/abc123
```

---

## 7. Review API

Lightweight API for the parts git can't handle: submitting reviews, managing permissions, listing changes with parsed metadata.

### 7.1 Endpoints

```
# Changes (read-only metadata parsed from git)
GET    /api/v1/repos/:owner/:repo/changes               List changes with parsed trailers
GET    /api/v1/repos/:owner/:repo/changes/:id            Change details + diff + focus areas + reviews
GET    /api/v1/repos/:owner/:repo/changes/:id/focused    Focused diff (only agent-highlighted sections)
POST   /api/v1/repos/:owner/:repo/changes/:id/merge      Merge (checks merge policy, then git merge)
POST   /api/v1/repos/:owner/:repo/changes/:id/rollback   Rollback

# Reviews (the one thing that isn't git)
POST   /api/v1/repos/:owner/:repo/changes/:id/reviews    Submit review (agent or human)
GET    /api/v1/repos/:owner/:repo/changes/:id/reviews     List reviews

# Repo info
GET    /api/v1/repos/:owner/:repo                         Repo info + clone URL + merge policy
GET    /api/v1/repos/:owner/:repo/tree/:branch            File listing
GET    /api/v1/repos/:owner/:repo/file/:branch/*path      File content

# Merge policy
GET    /api/v1/repos/:owner/:repo/merge-policy            Get current merge policy
PUT    /api/v1/repos/:owner/:repo/merge-policy             Update merge policy

# Agent management
POST   /api/v1/agents                                    Register agent (name, git_author)
GET    /api/v1/agents/:id/activity                        Activity log
PUT    /api/v1/repos/:owner/:repo/permissions              Edit permission rules

# Notifications
GET    /api/v1/notifications                              Pending reviews, merged changes
```

### 7.2 What the API Does NOT Do

- Accept code submissions (that's `git push`)
- Classify intent or risk (agents provide this in trailers)
- Generate change descriptions (agents write these in commits)

The API is a **read layer on top of git** plus reviews, permissions, and merge policies.

### 7.3 Merge Policies

Each repo has a configurable merge policy that determines when a change can be merged. This is how agent review autonomy is controlled.

**Default policy (safe):**

```json
{
  "require_human_approval": true,
  "min_approvals": 1,
  "agent_approval_weight": 0.5,
  "auto_merge_rules": null
}
```

With this default: agent reviews are advisory. They show up in the UI and give the human reviewer context ("your other agent already looked at this and thinks it's fine"), but only human approvals count toward the merge gate.

**Relaxed policy (trusting agents for low-risk work):**

```json
{
  "require_human_approval": false,
  "min_approvals": 1,
  "agent_approval_weight": 1.0,
  "auto_merge_rules": {
    "risk": ["low"],
    "max_files": 5
  }
}
```

With this: agent approvals count fully. Low-risk changes with 5 or fewer files can auto-merge if an agent approves. High-risk changes still queue for review.

**Strict policy (production repos):**

```json
{
  "require_human_approval": true,
  "min_approvals": 2,
  "agent_approval_weight": 0.5,
  "path_overrides": {
    "src/config/**": { "require_human_approval": true, "min_approvals": 2 },
    "docs/**": { "require_human_approval": false, "min_approvals": 1 }
  }
}
```

With this: most changes need 2 human approvals. Config files always need human review. Docs can be merged by agents alone.

**How merge evaluation works:**

```typescript
async function canMerge(change: Change, reviews: Review[]): Promise<{
  allowed: boolean;
  reason: string;
}> {
  const policy = await getMergePolicy(change.repoId);

  // Check auto-merge rules first
  if (policy.autoMergeRules) {
    const riskMatch = policy.autoMergeRules.risk?.includes(change.riskLevel);
    const fileMatch = !policy.autoMergeRules.maxFiles ||
      change.commitCount <= policy.autoMergeRules.maxFiles;
    if (riskMatch && fileMatch) {
      return { allowed: true, reason: 'Auto-merge: matches low-risk rules' };
    }
  }

  // Count weighted approvals
  const approvals = reviews.filter(r => r.verdict === 'approve');
  const humanApprovals = approvals.filter(r => r.reviewerType === 'human');
  const agentApprovals = approvals.filter(r => r.reviewerType === 'agent');

  const totalWeight =
    humanApprovals.length +
    (agentApprovals.length * policy.agentApprovalWeight);

  if (policy.requireHumanApproval && humanApprovals.length === 0) {
    return { allowed: false, reason: 'Requires at least one human approval' };
  }

  if (totalWeight < policy.minApprovals) {
    return {
      allowed: false,
      reason: `Needs ${policy.minApprovals} approvals, has ${totalWeight}`
    };
  }

  // Check path overrides
  const changedPaths = change.scope || [];
  for (const [pattern, override] of Object.entries(policy.pathOverrides || {})) {
    const matchingPaths = changedPaths.filter(p => minimatch(p, pattern));
    if (matchingPaths.length > 0 && override.requireHumanApproval && humanApprovals.length === 0) {
      return { allowed: false, reason: `Path ${pattern} requires human approval` };
    }
  }

  return { allowed: true, reason: 'All merge requirements met' };
}
```

**Sensible defaults:** New repos start with `require_human_approval: true`. Users who trust their agents can relax it per repo. The dashboard makes the current policy visible and easy to change.

---

## 8. ClawForge CLI

Wraps git with change-ref-aware workflows and review capabilities.

### 8.1 Commands

```bash
# ── Auth ──
clawforge auth login                          # OAuth → stores git credential
clawforge auth token <token>                  # Direct token → git credential store

# ── Clone ──
clawforge clone <owner/repo>                  # git clone + configures change ref fetching
# (adds fetch = +refs/changes/*/head:refs/remotes/origin/changes/* to .git/config)

# ── Changes (parsed from git, enriched with trailers) ──
clawforge change list                         # list branches with parsed intent, risk, status
clawforge change show <id>                    # intent, risk, scope, focus areas, reviews
clawforge change checkout <id>                # git fetch + checkout change ref
clawforge change diff <id>                    # default: focused if agent provided hints, full otherwise
clawforge change diff <id> --focused          # only agent-highlighted sections + context
clawforge change diff <id> --full             # full diff of all files
clawforge change merge <id>                   # merge via API (enforces merge policy)

# ── Review ──
clawforge review <id> --approve               # submit approval
clawforge review <id> --reject "reason"        # submit rejection
clawforge review <id> --comment "looks good but check X"

# ── Log (trailer-aware git log) ──
clawforge log                                 # git log but highlights Intent/Risk/Scope trailers
clawforge log --agent felix                    # filter to a specific agent's commits

# ── Repo Info ──
clawforge status                              # pending changes, recent activity summary
```

### 8.2 What `clawforge clone` Actually Does

```bash
# User runs:
clawforge clone user/myrepo

# Under the hood:
git clone https://clawforge.dev/user/myrepo.git
cd myrepo
git config --add remote.origin.fetch '+refs/changes/*/head:refs/remotes/origin/changes/*'
# Now `git fetch` will also pull all change refs
```

That's it. After this, the user has a standard git repo that also fetches change refs automatically.

### 8.3 What `clawforge change list` Shows

```
$ clawforge change list

ID        Branch                    Intent                              Risk   Status    Agent
abc123    fix/stale-cache           Fix stale cache bug on profile      low    pending   felix-openclaw
def456    feat/oauth2               Add OAuth2 login (Google, GitHub)   high   pending   felix-openclaw
ghi789    chore/deps                Update dependencies to latest       low    merged    cursor-bot
```

All of this data is parsed from git trailers on the branch commits. No separate database needed for intent/risk — it comes from git.

---

## 9. OpenClaw Integration

Since everything is git, integrating OpenClaw is trivial. No custom skill needed — just a prompt addition.

### 9.1 Prompt Addition for OpenClaw Agents

```
When working with ClawForge repositories, include these trailers at the end
of your git commit messages:

Intent: <what you were trying to accomplish>
Risk: <low|medium|high|critical>
Scope: <key files or areas affected>
Review-Focus: <file:lines — what the reviewer should look at and why>

Also add // REVIEW: comments in the code at lines that need human attention.
These are real comments that also serve as review guidance — ClawForge highlights
them in the review UI so the reviewer knows exactly where to focus.

Example:
  Fix authentication timeout causing session drops

  The JWT token refresh logic had a race condition where expired tokens
  could be used for up to 30 seconds. Fixed by adding a buffer to the
  expiry check.

  Intent: Fix session drops caused by JWT token refresh race condition
  Risk: medium
  Scope: src/auth/jwt.ts, src/middleware/session.ts
  Review-Focus: src/auth/jwt.ts:42-48 — the new expiry buffer logic
  Review-Focus: src/middleware/session.ts:15 — changed refresh interval
  Refs: issue #23

And in the code itself:
  // REVIEW: Added 30s buffer to expiry check to prevent race condition
  const isExpired = token.exp < (Date.now() / 1000) + 30;
```

### 9.2 Optional: ClawForge Skill (For Review Workflows)

If an agent wants to *review* other agents' work (not just push code), a lightweight skill:

```yaml
name: clawforge-review
description: Review pending changes on ClawForge repositories
tools:
  - name: clawforge_pending
    description: List pending changes that need review
    parameters:
      repo: string

  - name: clawforge_review
    description: Submit a review on a pending change
    parameters:
      change_id: string
      verdict: string       # approve | request_changes | comment
      summary: string
      comments: array?
```

But for the core workflow (clone → code → commit → push), agents just use git. No skill needed.

---

## 10. Tech Stack (MVP)

```
Backend:        TypeScript / Node.js (Hono or Fastify)
Database:       PostgreSQL 16 (changes, reviews, permissions, audit)
Git storage:    Bare git repos on disk, served via git-http-backend CGI
Event bus:      Redis 7 Streams
Auth:           JWT tokens, integrated with git credential store
Frontend:       Next.js 14 + Tailwind + shadcn/ui (dashboard)
CLI:            TypeScript + commander.js (@clawforge/cli on npm)
Hosting:        Single VPS (Hetzner/Railway), Docker Compose
```

Note what's NOT in the stack: no LLM API calls for intent classification. The agents provide the metadata. ClawForge just parses and displays it.

---

## 11. Build Plan — 6 Weeks

### Week 1: Git Server + Post-Push Processing

**Goal: A working git host that creates Change records from pushes.**

Tasks:
- TypeScript monorepo: api, dashboard, cli
- Docker Compose: app + PostgreSQL 16 + Redis 7 (Dockerfile installs git + git-http-backend)
- Database schema (Drizzle ORM): all tables including merge_policy on repos, review_focus/review_comments on changes, can_create_repos on agents, max_repos on users
- Bare git repo creation and storage
- Git Smart HTTP endpoints (proxy to git-http-backend)
- **Auto-repo creation on push**: if repo doesn't exist, create it (check agent ownership, can_create_repos, max_repos)
- Auth middleware (JWT tokens, Basic auth for git)
- **Post-push processing**: detect new branches, parse git trailers (including Review-Focus), scan diff for // REVIEW: inline comments, create Change records with review_focus and review_comments
- **Agent identification**: match commits to agents via git author or Agent: trailer
- Change ref publishing (refs/changes/*/head, trial merge at /merge)
- Event emission to Redis Streams

**Deliverable**: Agent pushes a branch with trailers → ClawForge creates a Change with parsed metadata + change refs.

### Week 2: Review API + Permissions

**Goal: Humans and agents can review changes and permission rules control who can merge.**

Tasks:
- Review API: submit, list, aggregate reviews on a change (supports both agent and human reviewers)
- **Merge policy system**: configurable per-repo merge policies (require_human_approval, min_approvals, agent_approval_weight, auto_merge_rules, path_overrides). Default: require human approval. GET/PUT merge-policy endpoints.
- Change merge endpoint: checks merge policy before performing git merge
- Change rollback endpoint
- Focused diff endpoint: GET /changes/:id/focused returns only agent-highlighted sections (from Review-Focus trailers and // REVIEW: comments)
- PermissionRule evaluation: glob matching, conditions (max files, no deletions, etc.)
- Auto-merge for changes matching low-risk + auto-merge rules with sufficient approvals
- Repo API: file tree, file content, repo info
- Notification events: change.created, change.needs_review, change.merged
- Audit event logging for all git and API operations

**Deliverable**: Full change lifecycle: push → detect → review → merge/reject, with merge policies and permissions enforced.

### Week 3: Supervision Dashboard

**Goal: Web UI for reviewing agent work.**

Tasks:
- Next.js app with GitHub OAuth
- Activity feed: real-time stream of agent pushes with parsed trailers (intent, risk, scope)
- Change review view: intent prominently displayed, risk badge, scope, inline diff, commit list
- **Focused review mode**: default view shows only agent-highlighted sections (from Review-Focus trailers and // REVIEW: comments) with context collapsed. Toggle to full diff. Blue highlight bars for focus areas.
- Review interface: comment on files/lines, approve/reject buttons
- Conflict indicator (from trial merge)
- Repo pages: file browser, clone URL, commit history with trailer highlighting
- **Merge policy settings page**: configure require_human_approval, min_approvals, agent_approval_weight, auto_merge_rules, path_overrides. Show current policy prominently. Warn when relaxing to agent-only approval.
- Agent activity page: which agent pushed what, when, review stats, audit trail
- Settings: permission rules

**Deliverable**: Human logs in, sees parsed agent activity, reviews with full context.

### Week 4: ClawForge CLI

**Goal: Humans can review and manage changes from the command line.**

Tasks:
- @clawforge/cli npm package with commander.js
- `auth login` / `auth token` (integrates with git credential store)
- `clone` (git clone + configures change ref fetching)
- `change list` (parsed trailer table view)
- `change show <id>` (full detail: intent, risk, scope, focus areas, reviews, diff stats)
- `change checkout <id>` (fetch + checkout change ref)
- `change diff <id>` — defaults to **focused view** if agent provided Review-Focus or REVIEW: hints (shows only highlighted sections with context), full diff otherwise. `--focused` and `--full` flags to override.
- `review <id> --approve / --reject / --comment`
- `change merge <id>` (server enforces merge policy, CLI shows policy status)
- `log` (trailer-aware git log with agent highlighting)
- `status` (pending changes summary)

**Deliverable**: Full review workflow from the terminal. Human or agent can list, checkout, review, merge.

### Week 5: Polish + Notifications

**Goal: Smooth experience, notifications, edge cases.**

Tasks:
- Telegram/Slack/Email notifications when changes need review
- OpenClaw channel-back: push notifications to agent's messaging channel
- Dashboard: side-by-side diff, syntax highlighting, review threads
- CLI: colored output, interactive review mode
- Handle edge cases: force pushes, branch deletion, rebases, amended commits
- Agent commit attribution in git log (proper author/committer separation)
- API docs / OpenAPI spec
- Rate limiting

**Deliverable**: Production-quality review experience across dashboard and CLI.

### Week 6: Launch Prep

**Goal: Ship to OpenClaw community.**

Tasks:
- Landing page
- Documentation: how to set up, trailer convention reference, CLI docs
- OpenClaw prompt template for trailer convention (publish to community)
- Optional lightweight review skill for ClawHub
- Demo video: agent pushes with trailers → human reviews via CLI + dashboard
- Security audit: git sandboxing, token management, input validation
- Monitoring + error tracking
- Soft launch: OpenClaw Discord, X, Hacker News

**Deliverable**: Public beta.

---

## 12. Agent Prompts for Building This

### 12.1 Repo Structure

```
clawforge/
├── packages/
│   ├── api/
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── git-http.ts           # Git Smart HTTP proxy
│   │   │   │   ├── changes.ts            # Change list, detail, merge, rollback
│   │   │   │   ├── reviews.ts            # Review submit, list
│   │   │   │   ├── repos.ts              # Repo info, file tree, file content
│   │   │   │   └── agents.ts             # Agent registration, activity
│   │   │   ├── services/
│   │   │   │   ├── git-backend.ts        # git-http-backend CGI proxy helper
│   │   │   │   ├── git.ts                # Bare git operations (merge, diff, etc.)
│   │   │   │   ├── post-push.ts          # Branch detection + trailer parsing
│   │   │   │   ├── trailer-parser.ts     # Parse git trailers from commits
│   │   │   │   ├── focus-parser.ts       # Parse Review-Focus trailers + // REVIEW: comments
│   │   │   │   ├── change-refs.ts        # Publish refs/changes/*/head + /merge
│   │   │   │   ├── agent-identity.ts     # Match commits to registered agents
│   │   │   │   ├── permissions.ts        # Permission rule evaluation
│   │   │   │   ├── merge-policy.ts       # Configurable merge approval evaluation
│   │   │   │   ├── auto-repo.ts          # Auto-create repos on push
│   │   │   │   └── reviews.ts            # Review logic
│   │   │   ├── models/                   # Drizzle ORM schema
│   │   │   ├── middleware/               # Auth, error handling
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── dashboard/                        # Next.js supervision UI
│   │   ├── app/
│   │   │   ├── dashboard/
│   │   │   ├── repos/
│   │   │   ├── changes/
│   │   │   └── agents/
│   │   └── package.json
│   │
│   └── cli/                              # ClawForge CLI
│       ├── src/
│       │   ├── commands/
│       │   │   ├── auth.ts
│       │   │   ├── clone.ts
│       │   │   ├── change.ts
│       │   │   ├── review.ts
│       │   │   ├── log.ts
│       │   │   └── status.ts
│       │   ├── lib/
│       │   │   ├── api-client.ts
│       │   │   ├── config.ts
│       │   │   └── git.ts
│       │   └── index.ts
│       └── package.json
│
├── docker-compose.yml
├── Dockerfile
├── .env.example
└── README.md
```

### 12.2 Key Prompts

**Prompt 1 — Project Bootstrap:**
> Set up a TypeScript monorepo called "clawforge" using npm workspaces. Three packages: api (Hono + Drizzle ORM + PostgreSQL), dashboard (Next.js 14 + Tailwind + shadcn/ui), cli (commander.js). Docker Compose with PostgreSQL 16 and Redis 7. Dockerfile based on node:20, must install git (apt-get install git). Verify git-http-backend exists at /usr/lib/git-core/git-http-backend.

**Prompt 2 — Database Schema:**
> Drizzle ORM schema: agents (id uuid, name, type enum, owner_id → users, git_author string for matching commits, can_create_repos boolean default true, metadata jsonb, created_at), users (id uuid, email, auth_provider, max_repos int default 50, created_at), repositories (id uuid, name, owner_id → users, created_by uuid → agents nullable, git_path, description, default_branch, is_public boolean default false, merge_policy jsonb default '{"require_human_approval":true,"min_approvals":1,"agent_approval_weight":0.5}', created_at), changes (id uuid, repo_id → repos, agent_id → agents nullable, branch, intent text nullable, risk_level enum default 'medium', scope text[] default '{}', review_focus jsonb default '[]' for [{path,lines?,description}], review_comments jsonb default '[]' for [{path,line,body}], refs text[] default '{}', commit_count int, has_conflicts boolean default false, status enum [pending/approved/rejected/merged/rolled_back], created_at, updated_at), reviews (id uuid, change_id → changes, reviewer_id uuid, reviewer_type enum [agent/human], verdict enum [approve/request_changes/comment], summary text, comments jsonb, created_at), permission_rules (id uuid, repo_id → repos, agent_id nullable, rule_type enum, pattern, conditions jsonb), audit_events (id uuid, repo_id, agent_id, action, metadata jsonb, timestamp).

**Prompt 3 — Git Smart HTTP + Auto-Repo + Post-Push:**
> Create packages/api/src/routes/git-http.ts: proxy GET /:owner/:repo.git/info/refs and POST git-upload-pack/git-receive-pack to git-http-backend CGI. Before receive-pack, check if the repo exists — if not, auto-create it (verify the agent belongs to the URL owner, check can_create_repos flag and max_repos limit, init bare repo, log audit event). After receive-pack, call post-push processing async. Create packages/api/src/services/post-push.ts: detect updated branches (not default branch), parse git trailers from commits using `git log --format='%(trailers:key=Intent,valueonly)'` etc., parse Review-Focus trailers into [{path, lines, description}], scan diff for `// REVIEW:` inline comments and extract [{path, line, body}], match agent identity via git author or Agent: trailer, create/update Change record with all parsed metadata including review_focus and review_comments, call change-refs service, emit Redis event. Create packages/api/src/services/trailer-parser.ts and packages/api/src/services/focus-parser.ts for the parsing logic.

**Prompt 4 — Review API + Merge Policies:**
> Create review routes: POST /api/v1/repos/:owner/:repo/changes/:id/reviews (submit review with verdict, summary, comments — reviewer_type is 'agent' or 'human' based on auth token), GET reviews. Create change routes: GET list (with parsed trailer data including review_focus), GET detail (with diff + focus areas + review comments), GET focused (returns only agent-highlighted sections from Review-Focus trailers and // REVIEW: comments), POST merge, POST rollback. Create packages/api/src/services/merge-policy.ts: the merge endpoint checks the repo's merge_policy before merging. Implement canMerge() that evaluates: require_human_approval (if true, at least one human must approve), min_approvals (weighted: human=1.0, agent=agent_approval_weight), auto_merge_rules (low-risk + max_files can skip review), and path_overrides (specific glob patterns can have stricter/looser rules). Default policy requires human approval. Create GET/PUT /api/v1/repos/:owner/:repo/merge-policy endpoints for owners to configure their policy.

**Prompt 5 — CLI:**
> Create packages/cli with commander.js. `auth login` opens browser OAuth and stores token via git credential store. `clone <owner/repo>` runs git clone then adds change ref fetch spec to .git/config. `change list` calls API and displays table with intent, risk, status, agent columns. `change show <id>` displays full change details including review focus areas parsed from agent trailers. `change checkout <id>` fetches refs/changes/<id>/head and /merge, checks out head. `change diff <id>` defaults to focused view if agent provided Review-Focus or REVIEW: hints (shows only highlighted sections with surrounding context), falls back to full diff otherwise. `change diff <id> --focused` forces focused view, `--full` forces full diff. `review <id> --approve|--reject|--comment` posts to API. `change merge <id>` posts merge (server enforces merge policy). `log` runs git log with trailer parsing and colored output highlighting Intent/Risk/Agent. Publish as @clawforge/cli.

---

## 13. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agents don't include trailers | High | Graceful fallback to commit message as intent. Trailers improve the experience but aren't mandatory. Dashboard works either way. |
| Inconsistent trailer formats across agents | Medium | Lenient parsing (case-insensitive, flexible separators). Document the convention clearly. |
| Git operation security | Critical | Sandbox git in container, validate inputs, chroot storage |
| git-http-backend CGI overhead | Medium | Process pooling at scale, consider Gitaly later |
| Agent token compromise | High | Short-lived tokens, repo-scoped, revocation + audit trail |
| Runaway repo creation by agents | Medium | Per-account repo limit (max_repos), per-agent can_create_repos flag, audit trail |
| Misconfigured merge policy allows bad code | High | Safe default (require_human_approval: true). Dashboard shows current policy prominently. Warn when relaxing to agent-only approval. |
| Agent reviews always approve (rubber-stamping) | Medium | Track agent review accuracy over time. Dashboard shows review stats per agent. Owners can adjust agent_approval_weight. |
| Low adoption | High | Zero friction for agents (just git + trailers). Focus on OpenClaw community first. |
| Trailer convention not adopted by other agent platforms | Medium | Works without trailers. Publish convention as open spec for other platforms to adopt. |

---

## 14. Success Metrics (First 90 Days)

- **10+ agents pushing** to ClawForge repos in first 2 weeks
- **100+ changes** processed with parsed trailers
- **50+ reviews** submitted via dashboard or CLI
- **< 3 second** clone time for repos under 100MB
- **Zero security incidents**
- **3+ organic community posts** about using it

---

## 15. What Comes After the MVP

1. **Trailer auto-detection** — Recognize common agent commit patterns even without explicit trailers
2. **Multi-agent repos** — Conflict detection when multiple agents push to the same repo
3. **CI/CD hooks** — Run tests on change branches, block merge on failure
4. **GitHub import + mirror** — Import repos from GitHub, optionally mirror pushes back
5. **Codebase Q&A** — Semantic search over repo contents (pgvector)
6. **Agent marketplace** — Pre-configured agents with the trailer convention built in
7. **Team features** — Orgs, shared repos, role-based access
8. **Self-hosted** — Docker image for on-prem
9. **Open trailer spec** — Publish the convention as a community standard for agent-git metadata