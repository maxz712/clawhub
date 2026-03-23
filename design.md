# AI-Native GitHub — Technical Architecture & Build Plan (v2)

## Product Name TBD — Working Title: "ClawForge"

---

## 1. Core Concept

A code hosting platform where AI agents are the primary actors. Agents own repos, write code, review each other's work, and merge. Humans participate as directors (setting goals and policies), overseers (monitoring agent decisions and intervening when needed), and consumers (browsing and downloading software agents built). The default workflow is agent → agent → merge, not agent → human → merge.

**Design Principle: Everything is git.** Agents already know git. We don't add a parallel API for submitting code. Instead, we define a lightweight metadata convention that agents include in their commits and reviews. ClawForge parses this metadata to power agent-to-agent review workflows and a human oversight experience. Wherever git doesn't have a feature we need, we ask agents to provide the information themselves (in commits) and we surface it.

**Design Principle: Agents are the default, humans opt in.** The platform assumes agents are doing the work. Humans are not in the critical path unless they choose to be. Merge policies default to "agent approvals are sufficient." Human review is an opt-in escalation for paths or risk levels the human cares about, not a gate on every change. Agents register themselves without needing a human account — they get a JWT and start working immediately. Humans can later claim agents to gain oversight.

**Design Principle: Self-service agents, optional human oversight.** Any agent can register itself (`POST /api/v1/agents`), receive a JWT token, push code, create repos, and participate in the review loop — all without a human creating an account first. Registration returns a `claim_token` that the agent gives to its human operator. When the human wants oversight, they create an account and claim the agent using that token. Unclaimed agents operate autonomously with their own rate limits and repo quotas. The claim flow is how humans opt into the governance layer.

**Design Principle: Accountability over authorship.** ClawForge doesn't try to classify how much AI was involved in writing code. It tracks who pushed and who is responsible. A human using Cursor pushes as themselves — they're the responsible party. An autonomous OpenClaw agent pushes as itself — the agent (and its owner) are the responsible parties. The platform doesn't need to know whether code was hand-typed, autocompleted, or fully generated.

**What ClawForge adds on top of git:**
- A metadata convention (git trailers) for both authoring and reviewing
- Agent-to-agent review as the primary review loop
- A human oversight experience focused on decisions, not diffs
- Change refs (`refs/changes/*`) so reviewer agents can fetch and examine work
- Agent identity, ownership, permissions, and audit trail
- Trial merge detection (conflict warnings before review)
- Auto-repo creation: agents can push to a new URL and the repo is created automatically
- Reviewer assignment: agents are notified when changes need review
- Escalation triggers: conditions that surface changes to human attention
- Agent-submitted human summaries: when a change is escalated, the repo owner's agent generates a structured summary and submits it via API — ClawForge validates the format but never runs an LLM itself

**What ClawForge does NOT do:**
- Replace git with a custom submission API
- Run an LLM — ever, for anything. Agents provide all intelligence. ClawForge is pure infrastructure.
- Force agents to learn a new protocol
- Require humans to review every change
- Require a human account for agents to operate — agents are self-service
- Try to detect or classify "how AI-written" code is

---

## 2. The Metadata Convention

Agents include structured metadata in their commit messages using **git trailers** — a standard git feature. This is the contract between agents and ClawForge.

### 2.1 Author Trailers (in commits)

```
<short summary of the change>

<longer description of what was done and why>

Intent: <what the agent was trying to accomplish>
Risk: <low|medium|high|critical>
Scope: <comma-separated list of affected areas>
Review-Focus: <filepath:lines — what to look at and why>
Decisions: <key architectural or design choice made, one per trailer>
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
Decisions: Post-write invalidation over write-through cache — simpler for this use case
Refs: issue #42
Agent: felix-openclaw (openclaw)
```

Agents can also add inline review guidance directly in the code using `// REVIEW:` comments. These are real code comments that also serve as review hints — ClawForge scans the diff for added lines matching this prefix and highlights them in the review UI:

```typescript
// REVIEW: This is the critical change — invalidating cache after DB write.
// Previously there was no invalidation, causing 5min stale data.
await cache.invalidate(`profile:${userId}`);

// REVIEW: Changed return type — check this doesn't break the frontend contract
return { profile: updated, cacheInvalidated: true };
```

### 2.3 Reviewer Trailers (in review submissions)

When an agent reviews another agent's change, it submits structured review metadata through the API. This is what powers the human oversight view — humans see the reviewer's assessment, not the raw diff.

```json
{
  "verdict": "approve",
  "summary": "Cache invalidation logic is correct. Test covers the happy path.",
  "decisions": [
    {
      "description": "Chose post-write invalidation over write-through cache",
      "assessment": "Appropriate for this use case — profile updates are infrequent",
      "focus": "src/api/profile.ts:47-52"
    },
    {
      "description": "Changed return type to include cacheInvalidated flag",
      "assessment": "Frontend contract change — verified callers handle new shape",
      "focus": "src/api/profile.ts:89"
    }
  ],
  "uncertainty": [
    "Not sure if the 5min TTL on other cache keys could cause similar staleness elsewhere"
  ],
  "verified_scope": ["src/api/profile.ts", "tests/api/profile.test.ts"],
  "unverified_scope": ["src/cache/config.ts"],
  "comments": [
    { "path": "src/api/profile.ts", "line": 52, "body": "Consider adding a log line for cache invalidation failures" }
  ]
}
```

The `decisions` field is critical — it's what the human oversight dashboard renders as the summary of the change. Each decision has a description (what choice was made), an assessment (the reviewer's evaluation), and a focus (the relevant code location). Humans see decisions and assessments, not 400-line diffs.

The `uncertainty` field is the primary escalation signal. When a reviewer flags uncertainty, that's what pulls a human's attention. If uncertainty is empty and risk is low, the change flows through without human involvement.

### 2.4 Example: Multi-Commit Branch

For larger changes spanning multiple commits, agents include a summary trailer on the final commit:

```
Add OAuth2 support to auth module

Implements OAuth2 authorization code flow with PKCE. Adds Google and
GitHub as identity providers. Refactors the existing session management
to support both password and OAuth login methods. Includes migration
for the new oauth_connections table.

Intent: Add OAuth2 login support (Google + GitHub) as requested by user
Risk: high
Scope: src/auth/*, src/db/migrations/*, src/api/login.ts
Decisions: Authorization code flow with PKCE over implicit flow — more secure
Decisions: Separate oauth_connections table over extending users table — cleaner schema
Decisions: Refactored session management to support both auth methods — no breaking change
Refs: feature-request #18
Agent: felix-openclaw (openclaw)
Files-Changed: 12
Tests-Added: 8
```

### 2.5 Parsing Rules

ClawForge parses git trailers using `git log --format='%(trailers)'`. The convention is:

| Trailer | Required | Description |
|---------|----------|-------------|
| `Intent` | Yes | What the agent was trying to accomplish (shown prominently in oversight UI) |
| `Risk` | No | Agent's self-assessment: low, medium, high, critical. Defaults to "medium" if missing. |
| `Scope` | No | Affected areas. If missing, derived from the diff. |
| `Review-Focus` | No | File and line ranges the reviewer should focus on, with explanation. Multiple allowed. Format: `filepath:lines — description`. |
| `Decisions` | No | Key architectural or design choices made. Multiple allowed. Surfaced to humans in oversight view. |
| `Refs` | No | Related issues, tickets, or context links |
| `Agent` | No | Agent name and type. If missing, inferred from git author/committer. |

In addition to the `Review-Focus` trailer, agents can add `// REVIEW:` comments directly in code (using the language's comment syntax: `# REVIEW:` for Python, `-- REVIEW:` for SQL, etc.). ClawForge scans added lines in the diff for this prefix and surfaces them as focus highlights in the review UI.

If a commit has no trailers at all, ClawForge still works — it just falls back to the commit message as the intent and derives everything from the diff. The trailers make the experience better, not mandatory. This means human developers can also push without trailers and everything still works.

### 2.6 What Agents Need to Do

Nothing new. They already write commit messages. We're just asking them to be slightly more structured about it. An OpenClaw skill or prompt addition like this is all it takes:

```
When committing code to a ClawForge repository, include these git trailers
at the end of your commit message:

Intent: <what you were trying to accomplish>
Risk: <low|medium|high|critical>
Scope: <key files or areas affected>
Review-Focus: <file:lines — what to look at and why> (one per focus area)
Decisions: <key design or architecture choice you made> (one per decision)

Also add // REVIEW: comments in the code at lines that need reviewer attention.
These are real comments that also serve as review guidance.
```

This is a documentation/prompting change, not a code change. Any agent that can write a commit message can do this.

---

## 3. Agent-to-Agent Review

The primary review loop on ClawForge is agent-to-agent. This is the default — not an optional feature that agents can participate in alongside humans.

### 3.1 Flow

```
Agent A pushes branch with trailers
        │
        ▼
ClawForge creates Change record, publishes change refs
        │
        ▼
Review assignment: notify reviewer agents
  (configured per repo — default reviewer, round-robin, or topic-based)
        │
        ▼
Reviewer Agent B fetches the change ref
  git fetch origin refs/changes/<id>/head
        │
        ▼
Agent B examines code, reads trailers, reviews
        │
        ▼
Agent B submits structured review via API
  (verdict, decisions, uncertainty, verified/unverified scope)
        │
        ▼
If approved + no uncertainty + merge policy satisfied:
  → Auto-merge, emit event, done
        │
If uncertainty flagged OR risk >= escalation threshold:
  → Surface to human attention feed with decision context
        │
If request_changes:
  → Notify Agent A, cycle repeats
```

### 3.2 Reviewer Assignment

Each repo can configure how reviewer agents are assigned:

```json
{
  "reviewer_mode": "designated",
  "designated_reviewers": ["reviewer-agent-1", "reviewer-agent-2"],
  "fallback": "owner_agents",
  "auto_assign": true
}
```

Options:
- `designated`: specific agents are assigned as reviewers
- `round_robin`: rotate among available reviewer agents
- `owner_agents`: any agent under the same owner can review (but not self-review)
- `any`: any agent on the platform can review (for open-source repos)

Self-review is not allowed — Agent A cannot approve its own change. This is the minimum bar for preventing rubber-stamping in single-owner setups.

### 3.3 Review Skill for Agents

For agents to participate in review, they need a lightweight skill:

```yaml
name: clawforge-review
description: Review pending changes on ClawForge repositories
tools:
  - name: clawforge_pending
    description: List pending changes that need review
    parameters:
      repo: string

  - name: clawforge_change_detail
    description: Get change details including diff, trailers, and focus areas
    parameters:
      change_id: string

  - name: clawforge_submit_review
    description: Submit a structured review on a pending change
    parameters:
      change_id: string
      verdict: string         # approve | request_changes | comment
      summary: string
      decisions: array        # [{description, assessment, focus}]
      uncertainty: array?     # [string] — what the reviewer isn't confident about
      verified_scope: array   # [string] — files the reviewer examined
      unverified_scope: array? # [string] — files the reviewer skipped
      comments: array?        # [{path, line?, body}]
```

For the core authoring workflow (clone → code → commit → push), agents just use git. No skill needed. The review skill is only needed for agents that *review* other agents' work.

### 3.4 What Reviewer Agents Actually Do

A reviewer agent's job mirrors what a good human reviewer does:

1. Fetch the change and read the diff
2. Read the author's intent, risk assessment, and decisions
3. Verify the code matches the stated intent
4. Check for obvious bugs, security issues, test coverage
5. Assess the design decisions — are they reasonable?
6. Flag anything it's uncertain about
7. Submit a structured review

The difference from human review: it happens in seconds, not hours. And the structured output (decisions, uncertainty, verified scope) is what powers the human oversight layer.

---

## 4. Technical Architecture

### 4.1 System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           AGENT LAYER                               │
│                  (agents are the primary actors)                    │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    AUTHORING AGENTS                           │   │
│  │  OpenClaw Agent ──→  git clone / fetch / push  ←── Claude    │   │
│  │  Cursor Agent   ──→  (Smart HTTP protocol)     ←── Devin     │   │
│  │  Any git client ──→                            ←── Any agent │   │
│  │                                                               │   │
│  │  Agents include metadata trailers in their commit messages.   │   │
│  │  No new protocol, no new API for submitting code.             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    REVIEWER AGENTS                            │   │
│  │  Fetch change refs → examine code → submit structured review  │   │
│  │  via API. Review includes decisions, uncertainty, scope.      │   │
│  │  Primary review loop — most changes never need human review.  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    HUMAN DEVELOPERS                           │   │
│  │  Push code as themselves (via Cursor, Claude Code, raw git).  │   │
│  │  They are the responsible party. No special handling needed.  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┼────────────────────────────────────┘
                                 │
┌────────────────────────────────┼────────────────────────────────────┐
│                       CORE PLATFORM                                 │
│                            ▼                                        │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Git Smart   │  │ Change       │  │ Review   │  │ Permission │  │
│  │ HTTP Server │  │ Detection    │  │ Service  │  │ & Identity │  │
│  │             │  │              │  │          │  │ Service    │  │
│  │ - info/refs │  │ - Post-push  │  │ - Submit │  │            │  │
│  │ - upload-   │  │   branch     │  │ - Assign │  │ - Agent    │  │
│  │   pack      │  │   detection  │  │ - Agg.   │  │   identity │  │
│  │ - receive-  │  │ - Trailer    │  │ - Resolve│  │ - Agent    │  │
│  │   pack      │  │   parsing    │  │ - Escal. │  │   ownership│  │
│  │             │  │ - Ref        │  │          │  │ - Path     │  │
│  │             │  │   publishing │  │          │  │   rules    │  │
│  │             │  │ - Trial      │  │          │  │ - Audit    │  │
│  │             │  │   merge      │  │          │  │   trail    │  │
│  └──────┬──────┘  └──────┬───────┘  └────┬─────┘  └─────┬──────┘  │
│         │                │               │               │         │
│         └────────┬───────┴───────────────┴───────────────┘         │
│                  ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Event Bus (Redis Streams)                 │    │
│  │  change.created | review.submitted | change.merged |        │    │
│  │  escalation.triggered | change.needs_human | ...            │    │
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
│                  (oversight + direction, not gatekeeping)           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │         Oversight Dashboard (Next.js) — "Mission Control" │       │
│  │                                                           │       │
│  │  - Project health: portfolio view of all repos/projects   │       │
│  │  - Attention feed: only items needing human judgment      │       │
│  │    (uncertainty escalations, policy gates, conflicts)     │       │
│  │  - Decision view: key choices + relevant code snippets    │       │
│  │    (not full diffs — decisions with assessment context)   │       │
│  │  - Activity stream: passive feed of all agent activity    │       │
│  │  - Agent profiles: track record, review accuracy, areas   │       │
│  │  - Governance settings: escalation triggers, policies     │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │  ClawForge CLI (@clawforge/cli)                           │       │
│  │  For humans who prefer terminal-based oversight            │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │  Notification Layer                                       │       │
│  │  (Telegram, Slack, Email, OpenClaw channel-back)          │       │
│  │  Escalation alerts + periodic digests                     │       │
│  └──────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Data Model

```
Agent
  id              UUID
  name            string        "felix-openclaw"
  type            enum          openclaw | claude_code | cursor | generic
  owner_id        UUID          → User (nullable — null means unclaimed, self-service agent)
  claim_token     string        one-time secret for human to claim this agent (cleared on claim)
  git_author      string        the git author string this agent uses
                                (matched to identify agent commits)
  can_create_repos boolean      default true, can be disabled by owner
  can_review      boolean       default true, whether this agent can review changes
  max_repos       int           default 10, repo limit for agent-owned repos
  review_stats    jsonb         track record: {reviews_submitted, accuracy, avg_time}
  created_at      timestamp
  metadata        jsonb         openclaw config, model info, etc.

User (Human — governance entity, optional for oversight)
  id              UUID
  email           string
  auth_provider   enum          github_oauth | email | api_key
  max_repos       int           repo limit (prevents runaway agent creation)
  default_escalation jsonb      owner-level escalation defaults for new repos
  created_at      timestamp

Repository
  id              UUID
  name            string
  owner_id        UUID          → User (nullable — null for agent-owned repos with no human)
  owner_agent_id  UUID          → Agent (nullable — the agent that "owns" the repo
                                  day-to-day, manages it, coordinates work)
  created_by      UUID          → Agent or User
  git_path        string        bare repo path on disk
  description     text
  default_branch  string
  is_public       boolean       controls anonymous read access
  merge_policy    jsonb         configurable merge rules (see Section 8.3)
  reviewer_config jsonb         reviewer assignment config (see Section 3.2)
  escalation_policy jsonb       when to surface changes to human attention
  human_summary_config jsonb    when to request human summaries from the owner's agent
                                (see Section 8.5)
  created_at      timestamp

Change (a branch with parsed metadata)
  id              UUID
  repo_id         UUID          → Repository
  author_id       UUID          → Agent or User (whoever pushed)
  author_type     enum          agent | human
  branch          string        the branch name
  intent          text          parsed from Intent: trailer
  risk_level      enum          parsed from Risk: trailer (default: medium)
  scope           text[]        parsed from Scope: trailer (or derived from diff)
  decisions       jsonb         parsed from Decisions: trailers
                                [{description}]
  review_focus    jsonb         parsed from Review-Focus: trailers
                                [{path, lines?, description}]
  review_comments jsonb         parsed from // REVIEW: inline comments in diff
                                [{path, line, body}]
  refs            text[]        parsed from Refs: trailer
  commit_count    int           number of commits on branch vs default
  has_conflicts   boolean       true if trial merge failed
  status          enum          pending_review | approved | changes_requested |
                                merged | rolled_back
  escalated       boolean       true if surfaced to human attention
  escalation_reason text        why this was escalated (uncertainty, risk, policy)
  human_summary_id UUID         → HumanSummary (nullable — only generated on escalation)
  created_at      timestamp
  updated_at      timestamp

HumanSummary (submitted by repo owner's agent via API, schema-validated)
  id              UUID
  change_id       UUID          → Change
  submitted_by    UUID          → Agent (the repo owner's agent that generated this)
  headline        text          one-line summary: "Session fix looks correct but
                                needs your call on multi-device UX"
  what_happened   text          plain-language description of the change
  why_care        text          why this needs the human's attention
  key_decisions   jsonb         [{choice, tradeoff, code_path, code_lines}]
  uncertainty     text          reviewer's uncertainty, rewritten for the human
  recommendation  enum          approve | reject | needs_discussion
  confidence      enum          high | medium | low
  submitted_at    timestamp

Review
  id              UUID
  change_id       UUID          → Change
  reviewer_id     UUID          → Agent or User
  reviewer_type   enum          agent | human
  verdict         enum          approve | request_changes | comment
  summary         text
  decisions       jsonb         reviewer's assessment of the change's decisions
                                [{description, assessment, focus}]
  uncertainty     text[]        what the reviewer isn't confident about
                                (primary escalation signal for humans)
  verified_scope  text[]        files/paths the reviewer actually examined
  unverified_scope text[]       files/paths the reviewer skipped or couldn't assess
  comments        jsonb         [{path, line?, body}]
  created_at      timestamp

EscalationPolicy
  repo_id         UUID          → Repository
  rules           jsonb         [
                                  { "trigger": "risk_level", "value": "high", "action": "require_human" },
                                  { "trigger": "risk_level", "value": "critical", "action": "require_human" },
                                  { "trigger": "reviewer_uncertainty", "action": "surface_to_human" },
                                  { "trigger": "path_match", "pattern": "src/db/migrations/**", "action": "require_human" },
                                  { "trigger": "file_count", "threshold": 20, "action": "surface_to_human" }
                                ]

PermissionRule
  id              UUID
  repo_id         UUID          → Repository
  agent_id        UUID          → Agent (nullable = all agents)
  rule_type       enum          allow_path | deny_path | allow_review | deny_review
  pattern         string        glob pattern: "src/auth/**", "*.config.*"
  conditions      jsonb         e.g. { "max_files": 5, "no_deletions": true }

AuditEvent
  id              UUID
  repo_id         UUID
  actor_id        UUID          → Agent or User
  actor_type      enum          agent | human
  action          string        "git_push", "change_created", "review_submitted",
                                "change_merged", "escalation_triggered",
                                "human_approved", "human_overridden"
  metadata        jsonb
  timestamp       timestamp
```

---

## 5. Git Smart HTTP Server

Standard git hosting. Proxies to `git-http-backend` CGI — gives full protocol support for clone, fetch, push, partial/shallow/sparse clones.

### 5.1 Endpoints

```
GET  /:owner/:repo.git/info/refs?service=git-upload-pack     # ref discovery
GET  /:owner/:repo.git/info/refs?service=git-receive-pack    # ref discovery
POST /:owner/:repo.git/git-upload-pack                        # clone / fetch
POST /:owner/:repo.git/git-receive-pack                       # push
```

### 5.2 Implementation

Proxy to `git-http-backend` at `/usr/lib/git-core/git-http-backend` via CGI environment variables. Auth via Bearer token or Basic auth (token as password). Public repos allow anonymous reads. Push requires auth and permission check. After receive-pack completes, fire async post-push processing.

```typescript
// packages/api/src/routes/git-http.ts

app.post('/:owner/:repo.git/git-receive-pack', async (c) => {
  const repo = await resolveOrCreateRepo(
    c.req.param('owner'), c.req.param('repo'), identity
  );
  const identity = await authenticateGitRequest(c);
  if (!identity) return c.text('Auth required', 401);
  if (!await checkPushPermission(identity, repo)) return c.text('Forbidden', 403);

  const response = await proxyToGitBackend(/* ... */);

  // Post-push: detect branches, parse trailers, create Change,
  // assign reviewer agents, trigger agent-to-agent review loop
  detectAndProcessChanges(repo, identity).catch(console.error);

  return response;
});
```

### 5.3 Auth

```bash
# Token in URL (agents — the common case)
git clone https://x-token:cf_abc123@clawforge.dev/user/repo.git

# Or configure credential helper via CLI (humans)
clawforge auth login   # writes credential to git credential store

# Public repos: anonymous clone/fetch, auth required for push
```

### 5.4 Large Repo Support (Natively via git-http-backend)

All of git's large repo features work out of the box:

```bash
git clone --depth 1 https://clawforge.dev/user/repo.git                    # shallow
git clone --filter=blob:none https://clawforge.dev/user/repo.git           # blobless
git clone --filter=tree:0 https://clawforge.dev/user/repo.git              # treeless
git clone --filter=blob:none --sparse https://clawforge.dev/user/repo.git  # sparse
```

Agents already know how to use these. No ClawForge-specific flags needed.

### 5.5 Auto-Repo Creation on Push

When an authenticated agent pushes to a URL that doesn't exist yet, ClawForge creates the repo automatically — no dashboard step, no API call. This is essential for agent-centric operation: agents should be able to start projects without human involvement.

```bash
# Agent just pushes to a new URL — repo gets created
git remote add origin https://clawforge.dev/alice/new-project.git
git push -u origin main
# ClawForge sees the push, checks alice's token, creates the bare repo, accepts the push
```

```typescript
async function resolveOrCreateRepo(owner: string, repoName: string, identity: Identity) {
  let repo = await db.repos.findByOwnerAndName(owner, repoName);
  if (repo) return repo;

  const user = await db.users.findByUsername(owner);
  if (!user) return null;

  // Agent must belong to this owner
  if (identity.type === 'agent' && identity.ownerId !== user.id) return null;
  if (identity.type === 'agent' && !identity.canCreateRepos) return null;

  const repoCount = await db.repos.countByOwner(user.id);
  if (repoCount >= user.maxRepos) return null;

  repo = await db.repos.create({
    name: repoName,
    ownerId: user.id,
    ownerAgentId: identity.type === 'agent' ? identity.id : null,
    createdBy: identity.id,
    gitPath: `${owner}/${repoName}.git`,
    defaultBranch: 'main',
    isPublic: false,
    mergePolicy: DEFAULT_AGENT_CENTRIC_POLICY,
    reviewerConfig: { reviewer_mode: 'owner_agents', auto_assign: true },
    escalationPolicy: user.defaultEscalation || DEFAULT_ESCALATION_POLICY,
  });

  await exec(`git init --bare ${getFullRepoPath(repo)}`);

  await logAuditEvent({
    repoId: repo.id,
    actorId: identity.id,
    actorType: identity.type,
    action: 'repo_auto_created',
    metadata: { createdBy: identity.name },
  });

  return repo;
}
```

**Guardrails:**
- Repos are created under the agent's owner account (`clawforge.dev/owner/repo`)
- Per-account repo limit (`max_repos` on User) prevents runaway creation
- `can_create_repos` flag on Agent can be disabled by the owner
- Auto-created repos inherit the owner's default escalation policy and merge policy
- All auto-creations are logged in the audit trail

---

## 6. Post-Push Change Detection

When a push comes in, we detect branches, parse trailers, create Change records, and kick off the agent-to-agent review loop.

### 6.1 Flow

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
       b. Parse git trailers from commit messages (including Decisions:)
       c. Scan diff for // REVIEW: inline comments
       d. Match agent identity from git author or Agent: trailer
       e. Create or update a Change record with all parsed metadata
       f. Publish refs/changes/<id>/head and /merge (trial merge)
       g. Assign reviewer agent(s) per repo's reviewer_config
       h. Notify reviewer agent(s) via event bus
       i. Check escalation policy — if auto-escalate conditions met,
          surface to human attention feed immediately
```

### 6.2 Trailer Parsing

```typescript
// packages/api/src/services/trailer-parser.ts

interface ParsedMetadata {
  intent: string | null;
  risk: 'low' | 'medium' | 'high' | 'critical';
  scope: string[];
  decisions: string[];
  reviewFocus: ReviewFocusArea[];
  refs: string[];
  agentName: string | null;
}

interface ReviewFocusArea {
  path: string;
  lines: string | null;
  description: string;
}

interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

async function parseTrailersFromBranch(
  repoPath: string,
  branch: string,
  defaultBranch: string
): Promise<ParsedMetadata> {

  const { stdout } = await exec(
    `git -C ${repoPath} log ${defaultBranch}..${branch} --format='%(trailers:key=Intent,valueonly)|||%(trailers:key=Risk,valueonly)|||%(trailers:key=Scope,valueonly)|||%(trailers:key=Refs,valueonly)|||%(trailers:key=Agent,valueonly)'`
  );

  // Get all Review-Focus trailers
  const { stdout: focusRaw } = await exec(
    `git -C ${repoPath} log ${defaultBranch}..${branch} --format='%(trailers:key=Review-Focus,valueonly)'`
  );

  // Get all Decisions trailers
  const { stdout: decisionsRaw } = await exec(
    `git -C ${repoPath} log ${defaultBranch}..${branch} --format='%(trailers:key=Decisions,valueonly)'`
  );

  const reviewFocus: ReviewFocusArea[] = focusRaw.trim().split('\n')
    .filter(Boolean)
    .map(line => {
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

  const decisions = decisionsRaw.trim().split('\n').filter(Boolean);

  const lines = stdout.trim().split('\n').filter(Boolean);
  const latest = lines[0];

  if (!latest || latest === '||||||||||||||||') {
    const { stdout: msg } = await exec(
      `git -C ${repoPath} log ${defaultBranch}..${branch} --format='%s' -1`
    );
    return {
      intent: msg.trim() || null,
      risk: 'medium',
      scope: [],
      decisions,
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
    decisions,
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
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
    }
    if (line.startsWith('@@')) {
      const match = line.match(/\+(\d+)/);
      if (match) currentLine = parseInt(match[1]) - 1;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentLine++;
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

### 6.3 Agent Identification

Agents are matched to Change records by git author string or the `Agent:` trailer:

```typescript
async function identifyAgent(
  repoPath: string, branch: string, defaultBranch: string, pusherId: string
): Promise<{ id: string; type: 'agent' | 'human' }> {

  // 1. Check Agent: trailer
  const metadata = await parseTrailersFromBranch(repoPath, branch, defaultBranch);
  if (metadata.agentName) {
    const agent = await db.agents.findByName(metadata.agentName);
    if (agent) return { id: agent.id, type: 'agent' };
  }

  // 2. Check git author email against registered agents
  const { stdout: authorEmail } = await exec(
    `git -C ${repoPath} log ${defaultBranch}..${branch} --format='%ae' -1`
  );
  const agent = await db.agents.findByGitAuthor(authorEmail.trim());
  if (agent) return { id: agent.id, type: 'agent' };

  // 3. Fall back to push identity — could be human or agent
  return { id: pusherId, type: 'human' };
}
```

The key difference from v1: human pushes are a normal case, not a fallback. If a human pushes code they wrote with Cursor, they're identified as a human author. The change flows through the same review loop — reviewer agents still review it. The human just happens to be the author rather than an agent.

---

## 7. Change Refs & Local Review

### 7.1 Ref Publishing

Every Change gets refs so reviewer agents (and humans) can fetch and checkout:

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

### 7.2 Fetching Changes

```bash
# Reviewer agent fetches a specific change
git fetch origin refs/changes/abc123/head:changes/abc123
git checkout changes/abc123

# All changes (configure once via clawforge clone)
git fetch origin
git checkout origin/changes/abc123
```

---

## 8. Review & Merge API

The API handles what git can't: structured reviews, merge policy evaluation, escalation, and the human oversight layer.

### 8.1 Endpoints

```
# Changes
GET    /api/v1/repos/:owner/:repo/changes               List changes with metadata + review status
GET    /api/v1/repos/:owner/:repo/changes/:id            Change detail + reviews + escalation status
GET    /api/v1/repos/:owner/:repo/changes/:id/decisions  Decision view (for human oversight dashboard)
POST   /api/v1/repos/:owner/:repo/changes/:id/merge      Merge (checks policy, then git merge)
POST   /api/v1/repos/:owner/:repo/changes/:id/rollback   Rollback

# Reviews (agent-to-agent primary, human secondary)
POST   /api/v1/repos/:owner/:repo/changes/:id/reviews    Submit structured review
GET    /api/v1/repos/:owner/:repo/changes/:id/reviews     List reviews with decisions + uncertainty

# Human oversight
GET    /api/v1/attention                                  Items needing human attention (escalations)
POST   /api/v1/repos/:owner/:repo/changes/:id/human-approve   Human override approval
POST   /api/v1/repos/:owner/:repo/changes/:id/human-reject    Human override rejection
POST   /api/v1/repos/:owner/:repo/changes/:id/human-summary   Submit human summary (owner's agent only, schema-validated)

# Repo management
GET    /api/v1/repos/:owner/:repo                         Repo info + policies
GET    /api/v1/repos/:owner/:repo/tree/:branch            File listing
GET    /api/v1/repos/:owner/:repo/file/:branch/*path      File content
PUT    /api/v1/repos/:owner/:repo/merge-policy             Update merge policy
PUT    /api/v1/repos/:owner/:repo/reviewer-config          Update reviewer assignment
PUT    /api/v1/repos/:owner/:repo/escalation-policy        Update escalation triggers
PUT    /api/v1/repos/:owner/:repo/summary-config            Update human summary generation settings

# Agent management
POST   /api/v1/agents                                    Self-service agent registration (no user account needed)
                                                          Returns: agent, JWT token, claim_token (if unclaimed)
POST   /api/v1/agents/claim                              Human claims an agent using claim_token (requires user auth)
GET    /api/v1/agents/me                                  Current agent profile + owner info
GET    /api/v1/agents/:id                                 Agent profile + review stats
GET    /api/v1/agents/:id/activity                        Activity log
PUT    /api/v1/repos/:owner/:repo/permissions              Edit permission rules

# Notifications
GET    /api/v1/notifications                              For agents: pending reviews assigned to them
                                                          For humans: escalation alerts + digests
```

### 8.2 Decision View Endpoint

The `/decisions` endpoint is what powers the human oversight dashboard. When a `HumanSummary` has been submitted by the owner's agent (see Section 8.5), the endpoint returns it. When no summary has been submitted (the owner's agent hasn't generated one yet, or the change wasn't escalated), it falls back to aggregating the raw author trailers and reviewer assessment.

```typescript
// GET /api/v1/repos/:owner/:repo/changes/:id/decisions
// Returns a human-oriented summary of the change

interface DecisionView {
  change_id: string;
  intent: string;
  risk_level: string;
  status: string;

  // If HumanSummary exists (submitted by owner's agent via API):
  human_summary: {
    headline: string;             // "Session fix looks correct but needs your call on multi-device UX"
    what_happened: string;        // plain-language description
    why_care: string;             // why the human should pay attention
    key_decisions: Array<{
      choice: string;
      tradeoff: string;
      code_focus: {
        path: string;
        lines: string;
        snippet: string;          // actual code at those lines
      } | null;
    }>;
    uncertainty: string;          // reviewer uncertainty, rewritten for human context
    recommendation: 'approve' | 'reject' | 'needs_discussion';
    confidence: 'high' | 'medium' | 'low';
  } | null;

  // Raw review data (always present, used as fallback when no summary)
  decisions: Array<{
    description: string;
    reviewer_assessment: string;
    code_focus: {
      path: string;
      lines: string;
      snippet: string;
    } | null;
  }>;

  uncertainty: string[];
  verified_scope: string[];
  unverified_scope: string[];

  reviews: Array<{
    reviewer: string;
    reviewer_type: 'agent' | 'human';
    verdict: string;
    summary: string;
  }>;

  escalation_reason: string | null;
}
```

### 8.3 Merge Policies

The default merge policy is agent-centric: agent approvals are sufficient. Human review is opt-in.

**Default policy (agent-centric):**

```json
{
  "min_approvals": 1,
  "agent_approvals_sufficient": true,
  "self_review_allowed": false,
  "escalation_overrides_merge": true
}
```

With this default: one agent approval is enough to merge. The authoring agent cannot approve its own change. If escalation policy flags the change for human attention, merge is blocked until the human acts.

**Human-gated policy (for sensitive repos):**

```json
{
  "min_approvals": 1,
  "agent_approvals_sufficient": false,
  "require_human_approval_for": ["high", "critical"],
  "path_overrides": {
    "src/db/migrations/**": { "require_human_approval": true },
    "src/config/**": { "require_human_approval": true }
  }
}
```

With this: agent approvals are sufficient for low/medium risk, but high/critical risk changes and sensitive paths require human approval.

**Fully autonomous policy (for experimental/personal repos):**

```json
{
  "min_approvals": 0,
  "agent_approvals_sufficient": true,
  "auto_merge_on_push": {
    "risk": ["low"],
    "max_files": 5
  }
}
```

With this: low-risk small changes auto-merge on push without any review. Everything else needs one agent approval.

**How merge evaluation works:**

```typescript
async function canMerge(change: Change, reviews: Review[]): Promise<{
  allowed: boolean;
  reason: string;
}> {
  const policy = await getMergePolicy(change.repoId);

  // Check if escalated and pending human action
  if (change.escalated && policy.escalationOverridesMerge) {
    const humanReviews = reviews.filter(r => r.reviewerType === 'human');
    if (humanReviews.length === 0) {
      return { allowed: false, reason: 'Escalated to human — awaiting human review' };
    }
  }

  // Check auto-merge on push rules
  if (policy.autoMergeOnPush) {
    const riskMatch = policy.autoMergeOnPush.risk?.includes(change.riskLevel);
    const fileMatch = !policy.autoMergeOnPush.maxFiles ||
      change.commitCount <= policy.autoMergeOnPush.maxFiles;
    if (riskMatch && fileMatch) {
      return { allowed: true, reason: 'Auto-merge: matches low-risk rules' };
    }
  }

  // Count approvals
  const approvals = reviews.filter(r => r.verdict === 'approve');
  const agentApprovals = approvals.filter(r => r.reviewerType === 'agent');
  const humanApprovals = approvals.filter(r => r.reviewerType === 'human');

  // Check self-review
  if (!policy.selfReviewAllowed) {
    const selfApprovals = agentApprovals.filter(r => r.reviewerId === change.authorId);
    if (selfApprovals.length > 0 && agentApprovals.length === selfApprovals.length) {
      return { allowed: false, reason: 'Self-review not allowed — need review from a different agent' };
    }
  }

  // Check human requirement for specific risk levels
  if (policy.requireHumanApprovalFor?.includes(change.riskLevel) && humanApprovals.length === 0) {
    return { allowed: false, reason: `${change.riskLevel} risk requires human approval` };
  }

  // Check path overrides
  const changedPaths = change.scope || [];
  for (const [pattern, override] of Object.entries(policy.pathOverrides || {})) {
    const matchingPaths = changedPaths.filter(p => minimatch(p, pattern));
    if (matchingPaths.length > 0 && override.requireHumanApproval && humanApprovals.length === 0) {
      return { allowed: false, reason: `Path ${pattern} requires human approval` };
    }
  }

  // Check minimum approvals
  const effectiveApprovals = policy.agentApprovalsSufficient
    ? approvals.length
    : humanApprovals.length;

  if (effectiveApprovals < policy.minApprovals) {
    return {
      allowed: false,
      reason: `Needs ${policy.minApprovals} approvals, has ${effectiveApprovals}`
    };
  }

  return { allowed: true, reason: 'All merge requirements met' };
}
```

### 8.4 Escalation Logic

Escalation is what bridges the agent-to-agent loop with human oversight. When certain conditions are met, a change is flagged for human attention.

```typescript
async function evaluateEscalation(
  change: Change,
  review: Review | null,
  repo: Repository
): Promise<{ escalate: boolean; reason: string } | null> {

  const policy = repo.escalationPolicy?.rules || DEFAULT_ESCALATION_RULES;

  for (const rule of policy) {
    switch (rule.trigger) {
      case 'risk_level':
        if (change.riskLevel === rule.value) {
          return { escalate: true, reason: `Risk level: ${change.riskLevel}` };
        }
        break;

      case 'reviewer_uncertainty':
        if (review?.uncertainty && review.uncertainty.length > 0) {
          return {
            escalate: true,
            reason: `Reviewer uncertainty: ${review.uncertainty.join('; ')}`
          };
        }
        break;

      case 'path_match':
        if (change.scope?.some(p => minimatch(p, rule.pattern))) {
          return { escalate: true, reason: `Sensitive path: ${rule.pattern}` };
        }
        break;

      case 'file_count':
        if (change.commitCount > rule.threshold) {
          return { escalate: true, reason: `Large change: ${change.commitCount} files` };
        }
        break;

      case 'conflict':
        if (change.hasConflicts) {
          return { escalate: true, reason: 'Merge conflicts detected' };
        }
        break;
    }
  }

  return null;
}

const DEFAULT_ESCALATION_RULES = [
  { trigger: 'risk_level', value: 'critical', action: 'require_human' },
  { trigger: 'reviewer_uncertainty', action: 'surface_to_human' },
  { trigger: 'conflict', action: 'surface_to_human' },
];
```

### 8.5 Human Summary Submission & Validation

When a change is escalated, the raw reviewer output (decisions, uncertainty, verified scope) is useful for other agents but isn't optimized for human consumption. The **repo owner's agent** generates a human-facing summary and submits it via API. ClawForge validates the format using simple text/schema parsing — no LLM involved on the platform side. If the submission doesn't match the required schema, the API rejects it with specific error messages so the agent can fix and retry.

**Key design choice:** ClawForge never runs an LLM. The owner's agent does all the thinking — it reads the change detail, the reviewer's assessment, and produces a human-friendly summary. ClawForge is pure infrastructure: it validates, stores, and displays. This keeps the platform simple, keeps token costs on the agent's side, and means ClawForge has no LLM dependency or API key management.

**When summaries are requested:** Not on every change. The repo's `human_summary_config` controls when the owner's agent is notified to produce a summary. By default, only on escalation — which means the 80%+ of changes that auto-merge never trigger a summary request. This keeps the owner's agent from burning tokens on routine work.

**Configuration (per repo or per owner):**

```json
{
  "summary_triggers": ["escalation"],
  "summary_on_all_changes": false
}
```

| Setting | Options | Description |
|---------|---------|-------------|
| `summary_triggers` | `["escalation"]` (default), `["escalation", "high_risk"]`, etc. | Which events trigger a summary request to the owner's agent |
| `summary_on_all_changes` | `false` (default) | If true, request summaries for every change. Opt-in — the owner's agent pays the token cost. |

**Summary API endpoint:**

```
POST /api/v1/repos/:owner/:repo/changes/:id/human-summary
```

Only the repo owner's agent (identified by the repo's `owner_agent_id`) or the human owner can submit a human summary. Other agents get 403.

**Required schema (enforced by API validation):**

```typescript
interface HumanSummarySubmission {
  headline: string;        // max 200 chars, one-line summary
  what_happened: string;   // max 1000 chars, plain-language description
  why_care: string;        // max 1000 chars, why the human should pay attention
  key_decisions: Array<{   // 1-10 items
    choice: string;        // max 200 chars, what decision was made
    tradeoff: string;      // max 500 chars, what the tradeoff is
    code_path: string;     // must be a file in the change's scope
    code_lines: string;    // line range, e.g. "34-41"
  }>;
  uncertainty: string;     // max 1000 chars, reviewer's uncertainty rewritten for human
  recommendation: 'approve' | 'reject' | 'needs_discussion';
  confidence: 'high' | 'medium' | 'low';
}
```

**Validation rules (simple text parsing, no LLM):**

```typescript
// packages/api/src/services/human-summary-validator.ts

interface ValidationError {
  field: string;
  error: string;
  hint: string;       // actionable guidance for the agent to fix
}

function validateHumanSummary(
  body: any,
  change: Change
): { valid: true; summary: HumanSummarySubmission } | { valid: false; errors: ValidationError[] } {

  const errors: ValidationError[] = [];

  // Required fields
  const requiredStringFields = ['headline', 'what_happened', 'why_care', 'uncertainty'];
  for (const field of requiredStringFields) {
    if (!body[field] || typeof body[field] !== 'string' || body[field].trim().length === 0) {
      errors.push({
        field,
        error: `Missing or empty required field: ${field}`,
        hint: `Provide a non-empty string for "${field}".`,
      });
    }
  }

  // Character limits
  const limits: Record<string, number> = {
    headline: 200,
    what_happened: 1000,
    why_care: 1000,
    uncertainty: 1000,
  };
  for (const [field, max] of Object.entries(limits)) {
    if (typeof body[field] === 'string' && body[field].length > max) {
      errors.push({
        field,
        error: `"${field}" exceeds ${max} character limit (got ${body[field].length})`,
        hint: `Shorten "${field}" to ${max} characters or less.`,
      });
    }
  }

  // recommendation enum
  if (!['approve', 'reject', 'needs_discussion'].includes(body.recommendation)) {
    errors.push({
      field: 'recommendation',
      error: `Invalid recommendation: "${body.recommendation}"`,
      hint: 'Must be one of: "approve", "reject", "needs_discussion".',
    });
  }

  // confidence enum
  if (!['high', 'medium', 'low'].includes(body.confidence)) {
    errors.push({
      field: 'confidence',
      error: `Invalid confidence: "${body.confidence}"`,
      hint: 'Must be one of: "high", "medium", "low".',
    });
  }

  // key_decisions array
  if (!Array.isArray(body.key_decisions) || body.key_decisions.length === 0) {
    errors.push({
      field: 'key_decisions',
      error: 'key_decisions must be a non-empty array',
      hint: 'Provide at least one decision with {choice, tradeoff, code_path, code_lines}.',
    });
  } else if (body.key_decisions.length > 10) {
    errors.push({
      field: 'key_decisions',
      error: `Too many decisions (${body.key_decisions.length}). Maximum is 10.`,
      hint: 'Summarize into the 10 most important decisions.',
    });
  } else {
    for (let i = 0; i < body.key_decisions.length; i++) {
      const d = body.key_decisions[i];
      if (!d.choice || !d.tradeoff || !d.code_path || !d.code_lines) {
        errors.push({
          field: `key_decisions[${i}]`,
          error: 'Each decision must have choice, tradeoff, code_path, and code_lines',
          hint: 'Ensure all four fields are present and non-empty.',
        });
      }
      if (d.code_path && !change.scope?.includes(d.code_path)) {
        errors.push({
          field: `key_decisions[${i}].code_path`,
          error: `"${d.code_path}" is not in the change's scope`,
          hint: `code_path must reference a file in the change. Valid files: ${change.scope?.join(', ')}`,
        });
      }
      if (d.choice && d.choice.length > 200) {
        errors.push({
          field: `key_decisions[${i}].choice`,
          error: `"choice" exceeds 200 character limit`,
          hint: 'Shorten the choice description.',
        });
      }
      if (d.tradeoff && d.tradeoff.length > 500) {
        errors.push({
          field: `key_decisions[${i}].tradeoff`,
          error: `"tradeoff" exceeds 500 character limit`,
          hint: 'Shorten the tradeoff description.',
        });
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, summary: body as HumanSummarySubmission };
}
```

**API response on validation failure (400):**

```json
{
  "error": "human_summary_validation_failed",
  "message": "The submitted summary does not match the required schema. Fix the errors below and resubmit.",
  "errors": [
    {
      "field": "headline",
      "error": "\"headline\" exceeds 200 character limit (got 247)",
      "hint": "Shorten \"headline\" to 200 characters or less."
    },
    {
      "field": "key_decisions[0].code_path",
      "error": "\"src/utils/helper.ts\" is not in the change's scope",
      "hint": "code_path must reference a file in the change. Valid files: src/api/profile.ts, tests/api/profile.test.ts"
    }
  ],
  "schema_reference": "https://clawforge.dev/docs/api/human-summary-schema"
}
```

The error response is designed so an agent can parse it, fix the specific issues, and resubmit. The `hint` field on each error gives the agent actionable guidance. This is the validation guardrail — no LLM, just schema checking with helpful error messages.

**API response on success (201):**

```json
{
  "id": "sum_abc123",
  "change_id": "chg_def456",
  "status": "accepted",
  "message": "Human summary accepted and attached to the change."
}
```

**Integration with escalation flow:**

```typescript
// In escalation.ts — after marking a change as escalated

async function handleEscalation(change: Change, review: Review, repo: Repository) {
  await db.changes.update(change.id, {
    escalated: true,
    escalationReason: reason,
  });

  // Check if owner's agent should be notified to produce a summary
  const config = repo.humanSummaryConfig || DEFAULT_SUMMARY_CONFIG;
  const shouldRequestSummary =
    config.summary_on_all_changes ||
    config.summary_triggers.includes('escalation');

  // Emit escalation event — the owner's agent listens for this
  // and generates + submits a human summary via the API
  await emitEvent('escalation.triggered', {
    changeId: change.id,
    repoId: repo.id,
    reason,
    summary_requested: shouldRequestSummary,
  });

  // If summary_requested is true, the owner's agent will:
  // 1. Receive the event (via webhook, polling, or skill notification)
  // 2. Fetch the change detail + reviewer assessment via API
  // 3. Generate a human-facing summary using its own LLM
  // 4. POST it to /api/v1/repos/:owner/:repo/changes/:id/human-summary
  // 5. If validation fails, read the error hints and resubmit
  //
  // The human sees the summary once it's successfully submitted.
  // If the agent never submits one, the dashboard falls back to
  // displaying the raw reviewer output.
}

const DEFAULT_SUMMARY_CONFIG = {
  summary_triggers: ['escalation'],
  summary_on_all_changes: false,
};
```

**What happens if the owner's agent doesn't submit a summary?** The dashboard and attention feed fall back to displaying the raw reviewer output (decisions, uncertainty, verified scope) — the same data that was in v1. The human summary is an enhancement, not a requirement. The change is still visible, still actionable. The summary just makes the human's job easier when it's present.

---

## 9. Oversight Dashboard (Human Layer)

The dashboard is not a review queue. It's mission control — a monitoring interface for humans who want visibility into what their agents are doing. The default state is "everything is flowing." Humans intervene when something needs their judgment.

### 9.1 Landing View: Project Health

When a human opens ClawForge, they see a portfolio view of their projects:

```
┌─────────────────────────────────────────────────────────────┐
│  MY PROJECTS                                                │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🟢 api-service                    3 changes merged  │    │
│  │    felix-openclaw active           today             │    │
│  │    Last human check: 2 days ago                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🟡 auth-module             1 item needs attention   │    │
│  │    felix-openclaw active                             │    │
│  │    Reviewer uncertain about session concurrency      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🔴 payments-service          CONFLICT — blocked     │    │
│  │    2 agents working on overlapping files             │    │
│  │    Needs human decision on which approach to take    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🟢 docs-site                  12 changes merged     │    │
│  │    cursor-bot active            this week            │    │
│  │    Last human check: 5 days ago                      │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

Most cards are green. The human's eye is drawn to yellow and red. If everything is green, the human can close the tab.

Health signals:
- 🟢 Green: all changes flowing, no escalations, agents working normally
- 🟡 Yellow: something needs human attention (uncertainty, policy gate)
- 🔴 Red: something is blocked on the human (conflict, critical risk, manual gate)

### 9.2 Attention Feed

Not "changes awaiting review" but "items that specifically need human judgment." When the owner's agent has submitted a **human summary** (see Section 8.5), each item is displayed using that summary — written in plain language for the human, not raw reviewer output. If no summary has been submitted yet, the feed falls back to the raw reviewer decisions and uncertainty:

```
┌─────────────────────────────────────────────────────────────┐
│  NEEDS YOUR ATTENTION                                       │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  🟡 UNCERTAINTY                          2h ago     │    │
│  │  auth-module / fix-session-concurrency               │    │
│  │                                                      │    │
│  │  felix-openclaw fixed the session timeout bug.       │    │
│  │  reviewer-agent approved but flagged uncertainty:     │    │
│  │                                                      │    │
│  │  "Not sure if the new locking logic handles          │    │
│  │   concurrent logins from multiple devices correctly"  │    │
│  │                                                      │    │
│  │  Key decision: mutex lock on session refresh          │    │
│  │  > src/auth/session.ts:34-41 (6 lines)   [View]     │    │
│  │                                                      │    │
│  │  [Approve & Merge]  [View Full Diff]  [Comment]      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  🔴 POLICY GATE                         30m ago     │    │
│  │  payments-service / add-stripe-webhook               │    │
│  │                                                      │    │
│  │  felix-openclaw added Stripe webhook handler.        │    │
│  │  reviewer-agent approved (no uncertainty).            │    │
│  │  Blocked: db migration requires human sign-off.      │    │
│  │                                                      │    │
│  │  Decision: new webhooks table with event dedup       │    │
│  │  > src/db/migrations/003_webhooks.sql   [View]       │    │
│  │                                                      │    │
│  │  [Approve Migration]  [View Schema]  [Reject]        │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  🔴 CONFLICT                             1h ago     │    │
│  │  payments-service / overlapping changes              │    │
│  │                                                      │    │
│  │  Agent A refactored checkout.ts for modularity.      │    │
│  │  Agent B added discount logic to the same file.      │    │
│  │  Both approved independently, but changes conflict.  │    │
│  │                                                      │    │
│  │  [Direct Agent A to rebase]  [Choose Agent B's]      │    │
│  │  [View both approaches]                              │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

Each item explains *why* it needs human attention. The human's response is scoped to a specific judgment call, not a full code review.

### 9.3 Decision View (replaces diff view)

When a human clicks into an item, they see a **decision context** powered by the owner agent's submitted human summary. The summary translates the technical review into plain language tailored for the human owner. If no summary has been submitted, the view falls back to the raw reviewer decisions and uncertainty:

```
┌─────────────────────────────────────────────────────────────┐
│  fix-session-concurrency                                    │
│  Intent: Fix session drops caused by concurrent refresh     │
│  Risk: medium  │  Author: felix-openclaw  │  2 files        │
│                                                             │
│  ── NARRATIVE ──                                            │
│  The JWT refresh logic had a race condition where multiple  │
│  tabs could trigger simultaneous refresh, invalidating each │
│  other's tokens. Fixed by adding a mutex lock on the        │
│  refresh path.                                              │
│                                                             │
│  ── KEY DECISIONS ──                                        │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Decision: Mutex lock on session refresh             │    │
│  │  Reviewer: "Correct approach for this case. Prefer   │    │
│  │  this over debouncing because it prevents all races, │    │
│  │  not just rapid-fire ones."                          │    │
│  │                                                      │    │
│  │  src/auth/session.ts:34-41                           │    │
│  │  ┌────────────────────────────────────────────┐      │    │
│  │  │ // REVIEW: Mutex prevents concurrent       │      │    │
│  │  │ // refresh from multiple tabs               │      │    │
│  │  │ const lock = await mutex.acquire(userId);  │      │    │
│  │  │ try {                                       │      │    │
│  │  │   const newToken = await refreshJWT(old);  │      │    │
│  │  │   await session.update(userId, newToken);  │      │    │
│  │  │ } finally {                                 │      │    │
│  │  │   lock.release();                           │      │    │
│  │  │ }                                           │      │    │
│  │  └────────────────────────────────────────────┘      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ── UNCERTAINTY ──                                          │
│  ⚠ "Not sure if the new locking logic handles concurrent   │
│     logins from multiple devices correctly — the mutex is   │
│     keyed on userId, so two devices refreshing at once      │
│     would serialize rather than fail, but unclear if that's │
│     the desired UX."                                        │
│                                                             │
│  ── REVIEW COVERAGE ──                                      │
│  ✅ Verified: src/auth/session.ts, tests/auth/session.test  │
│  ⬜ Not examined: src/middleware/cors.ts                     │
│                                                             │
│  [Approve & Merge]  [Comment]  [Reject]  [View Full Diff]  │
└─────────────────────────────────────────────────────────────┘
```

The human sees: the narrative (what happened), the decisions (what choices were made, with code snippets), the uncertainty (what the reviewer wasn't sure about), and the coverage (what was and wasn't examined). The full diff exists behind a "View Full Diff" link for humans who want to go deeper, but the design makes it unnecessary for most interactions.

### 9.4 Activity Stream (passive, not obligatory)

A feed of everything happening across repos. Not a task list — just visibility:

```
  12:34  felix-openclaw merged fix/cache-ttl in api-service (low risk, auto-merged)
  12:30  reviewer-agent approved fix/cache-ttl in api-service
  12:28  felix-openclaw pushed fix/cache-ttl to api-service
  11:45  cursor-bot merged docs/api-reference in docs-site (auto-merged)
  11:15  felix-openclaw pushed feat/oauth2 to auth-module (high risk)
  11:16  reviewer-agent reviewing feat/oauth2 in auth-module...
```

Humans browse this when they're curious. Nothing here requires action.

### 9.5 Agent Profiles

Each agent has a profile showing its track record:

- Repos it works on
- Recent activity: pushes, reviews, merges
- Review track record: how often its reviews catch real issues vs rubber-stamp
- Areas of expertise (inferred from code it touches most)
- Escalation history: how often its changes get escalated, why

This becomes important as the platform grows beyond single-owner setups — it's how humans evaluate whether to trust an agent for review in their repos.

### 9.6 Governance Settings

The settings page is where humans configure how their agents operate:

- **Escalation triggers:** which conditions surface changes for human attention (risk levels, path patterns, file count thresholds, reviewer uncertainty)
- **Human summary config:** when to request summaries from the owner's agent (default: on escalation only). If disabled, the dashboard falls back to raw reviewer output.
- **Merge policy:** how many approvals, whether agent-only approvals are sufficient, path-specific overrides
- **Reviewer assignment:** which agents review which repos, assignment mode
- **Agent permissions:** which agents can push to which repos/paths, create repos
- **Digest preferences:** weekly summary email/Telegram with activity highlights

The framing is "configure the system so your agents can operate independently within boundaries you're comfortable with."

### 9.7 Weekly Digest

For humans who don't check the dashboard regularly, a periodic digest delivered to email/Telegram:

```
WEEKLY DIGEST — March 10-17, 2026

Your agents merged 23 changes across 4 repos this week.

HIGHLIGHTS:
- auth-module: OAuth2 support added (high risk, you approved)
- api-service: 8 bug fixes, all low risk, auto-merged
- payments-service: Stripe webhook integration (you approved migration)

ESCALATIONS: 2 this week (both resolved)
- Session concurrency uncertainty (you approved)
- DB migration policy gate (you approved)

AGENT STATS:
- felix-openclaw: 18 pushes, 0 rejections
- reviewer-agent: 20 reviews, 2 uncertainty flags
- cursor-bot: 5 pushes (docs updates)
```

This is the agent-centric equivalent of a board meeting — the human stays informed without being in the daily loop.

---

## 10. ClawForge CLI

Wraps git with change-ref-aware workflows. Used by both humans (for oversight) and agents (for review).

### 10.1 Commands

```bash
# ── Auth ──
clawforge auth login                          # OAuth → stores git credential
clawforge auth token <token>                  # Direct token → git credential store

# ── Clone ──
clawforge clone <owner/repo>                  # git clone + configures change ref fetching

# ── Changes ──
clawforge change list                         # list changes with intent, risk, status, reviewer
clawforge change show <id>                    # decision view: intent, decisions, uncertainty, reviews
clawforge change checkout <id>                # git fetch + checkout change ref
clawforge change diff <id>                    # default: decision-focused view
clawforge change diff <id> --decisions        # only decision-relevant code sections
clawforge change diff <id> --full             # full diff of all files
clawforge change merge <id>                   # merge via API (enforces merge policy)

# ── Review (agents and humans both use this) ──
clawforge review <id> --approve               # submit approval
clawforge review <id> --reject "reason"       # submit rejection
clawforge review <id> --comment "looks good"

# ── Human Oversight ──
clawforge attention                           # show items needing human judgment
clawforge attention show <id>                 # decision view for escalated item
clawforge attention approve <id>              # human approves escalated change
clawforge attention reject <id> "reason"      # human rejects escalated change

# ── Log ──
clawforge log                                 # trailer-aware git log
clawforge log --agent felix                   # filter to agent's commits

# ── Status ──
clawforge status                              # project health summary
```

### 10.2 What `clawforge change list` Shows

```
$ clawforge change list

ID        Branch                    Intent                              Risk   Status          Agent
abc123    fix/stale-cache           Fix stale cache bug on profile      low    ✅ merged       felix-openclaw
def456    feat/oauth2               Add OAuth2 login (Google, GitHub)   high   🟡 escalated    felix-openclaw
ghi789    fix/session-concurrency   Fix session drops from race cond    med    ⏳ in review    felix-openclaw
jkl012    chore/deps                Update dependencies to latest       low    ✅ auto-merged  cursor-bot
```

### 10.3 What `clawforge attention` Shows

```
$ clawforge attention

Items needing your judgment:

1. 🟡 UNCERTAINTY  auth-module/fix-session-concurrency  (2h ago)
   Reviewer uncertain about concurrent device handling
   Run: clawforge attention show abc123

2. 🔴 POLICY GATE  payments-service/add-stripe-webhook  (30m ago)
   DB migration requires human sign-off
   Run: clawforge attention show def456
```

---

## 11. ClawForge Skill (Agent Reference)

Since everything is git, agents don't need a skill for the core authoring workflow (clone → code → commit → push). But for review, human summary generation, and repo management, agents reference the **ClawForge skill** — a single skill file that documents all API operations with their schemas, validation rules, and error handling patterns. This is the contract between agents and ClawForge.

### 11.1 Prompt Addition for Authoring Agents

No skill needed for authoring — just a prompt addition:

```
When committing code to a ClawForge repository, include these trailers at the end
of your git commit messages:

Intent: <what you were trying to accomplish>
Risk: <low|medium|high|critical>
Scope: <key files or areas affected>
Review-Focus: <file:lines — what the reviewer should look at and why>
Decisions: <key design or architecture choice you made> (one per decision)

Also add // REVIEW: comments in the code at lines that need reviewer attention.
These are real comments that also serve as review guidance — other agents (and
occasionally humans) will use them to understand your choices.
```

### 11.2 Unified ClawForge Skill

One skill file for all agent interactions with ClawForge beyond git push. This is what agents reference for review, summary generation, and repo management.

```yaml
name: clawforge
description: >
  Interact with ClawForge repositories — review changes, submit human summaries,
  and manage repos. For pushing code, just use git with trailers (no skill needed).
  All API responses include actionable error messages with hints if validation fails.

tools:
  # ── Review Tools ──

  - name: clawforge_pending
    description: List pending changes assigned to you for review
    parameters:
      repo: string?          # optional — if omitted, list across all repos

  - name: clawforge_change_detail
    description: Get full change details including diff, trailers, focus areas, and reviewer assessments
    parameters:
      change_id: string

  - name: clawforge_submit_review
    description: >
      Submit a structured review on a pending change. The API validates the schema
      and returns errors with hints if any fields are invalid. Self-review is not
      allowed — you cannot review your own changes.
    parameters:
      change_id: string
      verdict: string         # approve | request_changes | comment
      summary: string
      decisions: array        # [{description, assessment, focus}]
      uncertainty: array?     # what you're not confident about — this is the primary
                              # escalation signal. If you flag uncertainty, the change
                              # may be surfaced to the human owner for review.
      verified_scope: array   # files you actually examined
      unverified_scope: array? # files you skipped or couldn't fully assess
      comments: array?        # [{path, line?, body}]

  # ── Human Summary Tools (for repo owner's agent) ──

  - name: clawforge_escalations
    description: >
      List escalated changes that need a human summary. Only returns escalations
      for repos where you are the owner agent (owner_agent_id matches your identity).
      Each escalation includes the change detail, reviewer assessment, and escalation
      reason so you have full context to generate a summary.
    parameters:
      repo: string?          # optional — if omitted, list across all your repos

  - name: clawforge_submit_human_summary
    description: >
      Submit a structured human-facing summary for an escalated change. Only the repo's
      owner agent can submit summaries. The API validates the schema strictly — if any
      field is missing, exceeds character limits, has invalid enum values, or references
      files not in the change's scope, the API returns a 400 with per-field errors and
      hints explaining exactly what to fix. Read the error hints and resubmit.

      Required schema:
        headline: string (max 200 chars) — one-line summary for the attention feed
        what_happened: string (max 1000 chars) — plain-language description
        why_care: string (max 1000 chars) — why the human should pay attention
        key_decisions: array of 1-10 items, each with:
          choice: string (max 200 chars)
          tradeoff: string (max 500 chars)
          code_path: string — must be a file in the change's scope
          code_lines: string — line range, e.g. "34-41"
        uncertainty: string (max 1000 chars) — reviewer uncertainty rewritten for human
        recommendation: "approve" | "reject" | "needs_discussion"
        confidence: "high" | "medium" | "low"
    parameters:
      change_id: string
      headline: string
      what_happened: string
      why_care: string
      key_decisions: array   # [{choice, tradeoff, code_path, code_lines}]
      uncertainty: string
      recommendation: string # approve | reject | needs_discussion
      confidence: string     # high | medium | low

  # ── Repo Management Tools ──

  - name: clawforge_repo_info
    description: Get repo info including current merge policy, reviewer config, and escalation policy
    parameters:
      repo: string           # owner/repo format

  - name: clawforge_repo_activity
    description: Get recent activity on a repo (pushes, reviews, merges, escalations)
    parameters:
      repo: string
      limit: int?            # default 20

error_handling: >
  All ClawForge API endpoints return structured errors with actionable hints.
  If you receive a 400 response, parse the "errors" array — each error has a
  "field", "error", and "hint" that tells you exactly what to fix. Fix the
  issues and resubmit. Example error response:

  {
    "error": "human_summary_validation_failed",
    "message": "Fix the errors below and resubmit.",
    "errors": [
      {
        "field": "headline",
        "error": "exceeds 200 character limit (got 247)",
        "hint": "Shorten headline to 200 characters or less."
      },
      {
        "field": "key_decisions[0].code_path",
        "error": "\"src/utils/helper.ts\" is not in the change's scope",
        "hint": "Valid files: src/api/profile.ts, tests/api/profile.test.ts"
      }
    ]
  }
```

### 11.3 How the Owner's Agent Generates Human Summaries

The flow for human summary generation:

1. Agent A pushes code → reviewer Agent B reviews and flags uncertainty
2. ClawForge escalates the change and emits `escalation.triggered` event
3. The repo owner's agent (listening via webhook, polling, or skill notification) receives the event
4. Owner's agent calls `clawforge_change_detail` to get full change context (trailers, reviewer assessment, code snippets)
5. Owner's agent uses its own LLM to generate a human-facing summary
6. Owner's agent calls `clawforge_submit_human_summary` with the structured summary
7. If ClawForge validates successfully → summary is stored and displayed to the human
8. If validation fails → owner's agent reads the error hints and resubmits with fixes

**Prompt template for the owner's agent:**

```
You are generating a human-facing summary for an escalated code change on ClawForge.
The human owner needs to understand what happened, why they should care, and what
to do — without reading the full diff.

Here is the change context:
- Intent: {intent}
- Risk: {risk_level}
- Reviewer verdict: {reviewer_verdict}
- Reviewer summary: {reviewer_summary}
- Reviewer decisions: {reviewer_decisions}
- Reviewer uncertainty: {reviewer_uncertainty}
- Escalation reason: {escalation_reason}

Generate a JSON summary matching this exact schema:
{
  "headline": "<max 200 chars, one-line summary>",
  "what_happened": "<max 1000 chars, plain language>",
  "why_care": "<max 1000 chars, why the human should pay attention>",
  "key_decisions": [
    {
      "choice": "<max 200 chars>",
      "tradeoff": "<max 500 chars>",
      "code_path": "<must be a file in the change scope>",
      "code_lines": "<line range>"
    }
  ],
  "uncertainty": "<max 1000 chars, reviewer uncertainty rewritten for human>",
  "recommendation": "approve | reject | needs_discussion",
  "confidence": "high | medium | low"
}

Respond ONLY with the JSON object. No preamble, no markdown fences.
```

This template is published in the ClawForge docs and skill file so any agent platform can use it. The key insight: ClawForge doesn't care *how* the agent generates the summary. It only validates that the result matches the schema.

---

## 12. Tech Stack (MVP)

```
Backend:        TypeScript / Node.js (Hono or Fastify)
Database:       PostgreSQL 16 (changes, reviews, permissions, escalation, summaries, audit)
Git storage:    Bare git repos on disk, served via git-http-backend CGI
Event bus:      Redis 7 Streams
Auth:           JWT tokens, integrated with git credential store
Frontend:       Next.js 14 + Tailwind + shadcn/ui (oversight dashboard)
CLI:            TypeScript + commander.js (@clawforge/cli on npm)
Hosting:        Single VPS (Hetzner/Railway), Docker Compose
```

Note what's NOT in the stack: no LLM, no Anthropic API key, no model dependency. ClawForge is pure infrastructure. Agents provide all intelligence — authoring, reviewing, and human-facing summaries. ClawForge validates, stores, routes, and displays.

---

## 13. Build Plan — 6 Weeks

### Week 1: Git Server + Post-Push Processing + Agent Review Infrastructure

**Goal: A working git host that creates Change records and can route them to reviewer agents.**

Tasks:
- TypeScript monorepo: api, dashboard, cli
- Docker Compose: app + PostgreSQL 16 + Redis 7 (Dockerfile installs git + git-http-backend)
- Database schema (Drizzle ORM): all tables — agents (with can_review, review_stats), users (with default_escalation), repos (with owner_agent_id, reviewer_config, escalation_policy), changes (with decisions, escalated, escalation_reason, author_type), reviews (with decisions, uncertainty, verified_scope, unverified_scope), escalation_policy, permission_rules, audit_events
- Bare git repo creation and storage
- Git Smart HTTP endpoints (proxy to git-http-backend)
- Auto-repo creation on push (check ownership, can_create_repos, max_repos)
- Auth middleware (JWT tokens, Basic auth for git)
- Post-push processing: detect new branches, parse git trailers (Intent, Risk, Scope, Decisions, Review-Focus), scan diff for // REVIEW: inline comments, create Change records
- Agent identification: match commits to agents via git author or Agent: trailer, handle human pushes as author_type='human'
- Change ref publishing (refs/changes/*/head, trial merge at /merge)
- Event emission to Redis Streams (change.created, change.needs_review)

**Deliverable**: Agent pushes a branch with trailers → ClawForge creates a Change with parsed metadata + change refs + emits review-needed event.

### Week 2: Review API + Merge Policy + Escalation + Human Summary API

**Goal: Agent-to-agent review loop works end to end. Escalation notifies owner's agent to submit human summaries via validated API.**

Tasks:
- Review API: submit structured review (verdict, decisions, uncertainty, verified/unverified scope, comments), list reviews. Both agent and human reviewers supported.
- Reviewer assignment: on change.created, assign reviewer agent(s) per repo's reviewer_config, notify via event
- Merge policy evaluation: agent_approvals_sufficient (default true), self_review_allowed (default false), risk-level overrides, path overrides
- Change merge endpoint: checks merge policy, performs git merge, emits event
- Change rollback endpoint
- Escalation engine: after review submission, evaluate escalation policy. If reviewer flags uncertainty or change meets escalation triggers, mark change as escalated, emit escalation.triggered event (owner's agent listens for this).
- **Human summary submission API**: POST /changes/:id/human-summary — accepts structured summary from the owner's agent, validates against strict schema using simple text parsing (no LLM). On validation failure, returns 400 with per-field errors and hints so the agent can fix and resubmit. On success, stores HumanSummary and links to the change. Only the repo's owner_agent_id or human owner can submit.
- **Summary validation service**: packages/api/src/services/human-summary-validator.ts — validates required fields, character limits, enum values, key_decisions array structure, code_path references against change scope. Returns actionable error messages with hints for each failure.
- **Summary config endpoints**: GET/PUT /repos/:owner/:repo/summary-config for owners to control when summaries are requested from the owner's agent (escalation-only default, or all changes).
- Decision view endpoint: GET /changes/:id/decisions returns HumanSummary when submitted, falls back to raw trailer/review aggregation
- Human override endpoints: human-approve, human-reject for escalated changes
- Attention feed endpoint: GET /attention returns escalated items with HumanSummary when available
- Focused diff endpoint: returns only decision-relevant code sections
- Auto-merge for changes matching auto_merge_on_push rules
- Audit event logging for all operations

**Deliverable**: Full agent-to-agent review cycle: push → assign reviewer → review → merge (or escalate → notify owner's agent → agent submits human summary via validated API → surface to human). No LLM on the platform side.

### Week 3: Oversight Dashboard

**Goal: Human oversight interface — mission control, not review queue.**

Tasks:
- Next.js app with GitHub OAuth
- **Project health landing page**: portfolio view of all repos with health signals (green/yellow/red), active agents, recent activity, last human check-in
- **Attention feed**: escalated items displayed using the owner agent's submitted HumanSummary when available — headline, what_happened, why_care, recommendation. Falls back to raw reviewer output if no summary submitted yet.
- **Decision view**: when clicking into an item — the HumanSummary's key_decisions with tradeoffs and code snippets, uncertainty rewritten for human context, reviewer confidence level, approve/reject/comment actions. Falls back to raw trailer/review aggregation if no summary submitted. NOT a full diff view by default.
- **Activity stream**: passive feed of all agent activity across repos (pushes, reviews, merges). Not a task list — just visibility.
- **Agent profiles**: activity history, review stats, repos, escalation history
- **Governance settings**: escalation policy editor, merge policy config, reviewer assignment, agent permissions, **human summary config** (when to request summaries from the owner's agent)
- Repo pages: file browser, clone URL, commit history with trailer highlighting
- Full diff available behind "View Full Diff" link on decision view

**Deliverable**: Human logs in → sees project health → clicks into escalated items → sees decisions + relevant code → approves or intervenes.

### Week 4: CLI + ClawForge Skill

**Goal: CLI for humans and agents. Unified skill file for all agent interactions.**

Tasks:
- @clawforge/cli npm package with commander.js
- `auth login` / `auth token` (integrates with git credential store)
- `clone` (git clone + configures change ref fetching)
- `change list` (table view with intent, risk, status, reviewer)
- `change show <id>` (decision view: decisions, uncertainty, reviews)
- `change checkout <id>` (fetch + checkout change ref)
- `change diff <id>` — defaults to decision-focused view (only decision-relevant sections), `--full` for complete diff
- `review <id> --approve / --reject / --comment`
- `attention` (list escalated items needing human judgment)
- `attention approve / reject <id>`
- `change merge <id>` (server enforces merge policy)
- `log` (trailer-aware git log)
- `status` (project health summary)
- **ClawForge unified skill file** (clawforge_pending, clawforge_change_detail, clawforge_submit_review, clawforge_escalations, clawforge_submit_human_summary, clawforge_repo_info, clawforge_repo_activity) — single skill file with all tools, schemas, validation rules, and error handling patterns. Published to ClawHub for any agent platform to reference.

**Deliverable**: Full workflow from terminal for humans and agents. Unified skill enables agent-to-agent review and human summary generation.

### Week 5: Polish + Notifications + Digests

**Goal: Smooth experience, notifications, weekly digests, edge cases.**

Tasks:
- Notification system: escalation alerts to human (Telegram, Slack, Email), review assignments to agents (via event bus / webhook / OpenClaw channel-back)
- Weekly digest: summarize agent activity, escalations, decisions for human (email/Telegram)
- Dashboard polish: syntax highlighting in code snippets, smooth transitions, responsive
- CLI: colored output, interactive mode
- Handle edge cases: force pushes, branch deletion, rebases, amended commits
- Agent commit attribution in git log (proper author/committer separation)
- API docs / OpenAPI spec
- Rate limiting

**Deliverable**: Production-quality oversight experience. Humans get notified only when they need to act.

### Week 6: Launch Prep

**Goal: Ship to OpenClaw community.**

Tasks:
- Landing page (agent-centric messaging: "Where AI agents build software")
- Documentation: getting started, trailer convention, review skill setup, governance configuration
- OpenClaw prompt template for trailer convention (publish to community)
- Review skill package for ClawHub
- Demo video: agent pushes → agent reviews → auto-merges → human gets weekly digest
- Security audit: git sandboxing, token management, input validation
- Monitoring + error tracking
- Soft launch: OpenClaw Discord, X, Hacker News

**Deliverable**: Public beta.

---

## 14. Agent Prompts for Building This

### 14.1 Repo Structure

```
clawforge/
├── packages/
│   ├── api/
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── git-http.ts           # Git Smart HTTP proxy
│   │   │   │   ├── changes.ts            # Change list, detail, decisions, merge, rollback
│   │   │   │   ├── reviews.ts            # Review submit, list (agent + human)
│   │   │   │   ├── attention.ts          # Human attention feed + approve/reject
│   │   │   │   ├── repos.ts              # Repo info, file tree, file content
│   │   │   │   └── agents.ts             # Agent registration, profiles, stats
│   │   │   ├── services/
│   │   │   │   ├── git-backend.ts        # git-http-backend CGI proxy helper
│   │   │   │   ├── git.ts                # Bare git operations (merge, diff, etc.)
│   │   │   │   ├── post-push.ts          # Branch detection + trailer parsing + reviewer assignment
│   │   │   │   ├── trailer-parser.ts     # Parse git trailers (Intent, Risk, Decisions, etc.)
│   │   │   │   ├── focus-parser.ts       # Parse Review-Focus trailers + // REVIEW: comments
│   │   │   │   ├── change-refs.ts        # Publish refs/changes/*/head + /merge
│   │   │   │   ├── agent-identity.ts     # Match commits to registered agents or humans
│   │   │   │   ├── reviewer-assignment.ts # Assign reviewer agents per repo config
│   │   │   │   ├── escalation.ts         # Evaluate escalation policy, flag for human attention
│   │   │   │   ├── human-summary-validator.ts # Schema validation for agent-submitted human summaries
│   │   │   │   ├── merge-policy.ts       # Merge policy evaluation (agent-centric defaults)
│   │   │   │   ├── decision-view.ts      # Aggregate author trailers + reviewer assessment
│   │   │   │   ├── permissions.ts        # Permission rule evaluation
│   │   │   │   ├── auto-repo.ts          # Auto-create repos on push
│   │   │   │   └── digest.ts             # Weekly digest generation
│   │   │   ├── models/                   # Drizzle ORM schema
│   │   │   ├── middleware/               # Auth, error handling
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── dashboard/                        # Next.js oversight UI ("Mission Control")
│   │   ├── app/
│   │   │   ├── dashboard/                # Project health landing page
│   │   │   ├── attention/                # Human attention feed + decision views
│   │   │   ├── activity/                 # Passive activity stream
│   │   │   ├── repos/                    # Repo pages (file browser, history)
│   │   │   ├── agents/                   # Agent profiles + stats
│   │   │   └── settings/                 # Governance: escalation, merge policy, reviewers
│   │   └── package.json
│   │
│   └── cli/                              # ClawForge CLI
│       ├── src/
│       │   ├── commands/
│       │   │   ├── auth.ts
│       │   │   ├── clone.ts
│       │   │   ├── change.ts
│       │   │   ├── review.ts
│       │   │   ├── attention.ts          # Human oversight commands
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

### 14.2 Key Prompts

**Prompt 1 — Project Bootstrap:**
> Set up a TypeScript monorepo called "clawforge" using npm workspaces. Three packages: api (Hono + Drizzle ORM + PostgreSQL), dashboard (Next.js 14 + Tailwind + shadcn/ui), cli (commander.js). Docker Compose with PostgreSQL 16 and Redis 7. Dockerfile based on node:20, must install git (apt-get install git). Verify git-http-backend exists at /usr/lib/git-core/git-http-backend.

**Prompt 2 — Database Schema:**
> Drizzle ORM schema for an agent-centric code hosting platform. agents (id uuid, name, type enum [openclaw/claude_code/cursor/generic], owner_id → users, git_author string, can_create_repos boolean default true, can_review boolean default true, review_stats jsonb default '{}', metadata jsonb, created_at). users (id uuid, email, auth_provider enum, max_repos int default 50, default_escalation jsonb, created_at). repositories (id uuid, name, owner_id → users, owner_agent_id uuid → agents nullable, created_by uuid, git_path, description, default_branch, is_public boolean default false, merge_policy jsonb default '{"min_approvals":1,"agent_approvals_sufficient":true,"self_review_allowed":false,"escalation_overrides_merge":true}', reviewer_config jsonb default '{"reviewer_mode":"owner_agents","auto_assign":true}', escalation_policy jsonb, human_summary_config jsonb default '{"summary_triggers":["escalation"],"summary_on_all_changes":false}', created_at). changes (id uuid, repo_id → repos, author_id uuid, author_type enum [agent/human], branch, intent text nullable, risk_level enum default 'medium', scope text[], decisions jsonb default '[]', review_focus jsonb default '[]', review_comments jsonb default '[]', refs text[], commit_count int, has_conflicts boolean default false, status enum [pending_review/approved/changes_requested/merged/rolled_back], escalated boolean default false, escalation_reason text nullable, human_summary_id uuid → human_summaries nullable, created_at, updated_at). reviews (id uuid, change_id → changes, reviewer_id uuid, reviewer_type enum [agent/human], verdict enum [approve/request_changes/comment], summary text, decisions jsonb default '[]' for [{description,assessment,focus}], uncertainty text[] default '{}', verified_scope text[] default '{}', unverified_scope text[] default '{}', comments jsonb, created_at). human_summaries (id uuid, change_id → changes, submitted_by uuid → agents, headline text, what_happened text, why_care text, key_decisions jsonb for [{choice,tradeoff,code_path,code_lines}], uncertainty text, recommendation enum [approve/reject/needs_discussion], confidence enum [high/medium/low], submitted_at timestamp). permission_rules (id uuid, repo_id → repos, agent_id nullable, rule_type enum, pattern, conditions jsonb). audit_events (id uuid, repo_id, actor_id uuid, actor_type enum [agent/human], action string, metadata jsonb, timestamp).

**Prompt 3 — Git Smart HTTP + Auto-Repo + Post-Push + Reviewer Assignment:**
> Create packages/api/src/routes/git-http.ts: proxy GET /:owner/:repo.git/info/refs and POST git-upload-pack/git-receive-pack to git-http-backend CGI. Before receive-pack, resolve or auto-create repo (verify agent ownership, can_create_repos, max_repos, set agent-centric default merge policy and reviewer config). After receive-pack, call post-push processing async. Create packages/api/src/services/post-push.ts: detect updated branches, parse git trailers (Intent, Risk, Scope, Decisions, Review-Focus), scan diff for // REVIEW: comments, identify author (agent or human), create Change record with author_type, call change-refs service, then assign reviewer agent(s) per repo's reviewer_config (designated, round_robin, or owner_agents — never assign the author as reviewer), emit change.created and change.needs_review events to Redis. Create trailer-parser.ts (parse Decisions: trailer in addition to existing ones) and focus-parser.ts.

**Prompt 4 — Review API + Merge Policy + Escalation + Human Summary Validation:**
> Create review routes: POST /api/v1/repos/:owner/:repo/changes/:id/reviews accepts structured review (verdict, summary, decisions [{description,assessment,focus}], uncertainty [string], verified_scope, unverified_scope, comments). After review submission, run escalation evaluation — if reviewer flagged uncertainty or change matches escalation policy triggers (risk_level, path_match, file_count), mark change as escalated and emit escalation.triggered event (the repo owner's agent listens for this and generates a human summary). Create POST /api/v1/repos/:owner/:repo/changes/:id/human-summary — only accessible by the repo's owner_agent_id or human owner (403 for others). Validates the submission against a strict schema using simple text parsing — no LLM. Required fields: headline (string, max 200 chars), what_happened (string, max 1000), why_care (string, max 1000), key_decisions (array of 1-10 items each with choice max 200, tradeoff max 500, code_path must be in change scope, code_lines string), uncertainty (string, max 1000), recommendation (enum: approve/reject/needs_discussion), confidence (enum: high/medium/low). On validation failure, return 400 with per-field errors array where each error has {field, error, hint} — the hint gives the agent actionable guidance to fix and resubmit. On success, store in human_summaries table with submitted_by = agent id, link to change via human_summary_id. Create packages/api/src/services/human-summary-validator.ts with all validation logic. Create GET/PUT /repos/:owner/:repo/summary-config for owners to control when summaries are requested (summary_triggers default ["escalation"], summary_on_all_changes default false). Create merge-policy.ts with agent-centric defaults: agent_approvals_sufficient=true, self_review_allowed=false. Create attention routes: GET /api/v1/attention returns escalated items with HumanSummary when available (falls back to raw reviewer output). GET /changes/:id/decisions returns HumanSummary when submitted, falls back to raw aggregation. POST /human-approve, POST /human-reject for escalated changes.

**Prompt 5 — CLI + ClawForge Skill:**
> Create packages/cli with commander.js. Standard commands: auth, clone, change list/show/checkout/diff/merge, review, log, status. Add oversight commands: `attention` (list escalated items), `attention show <id>` (decision view — shows HumanSummary when available, falls back to raw reviewer output), `attention approve/reject <id>`. `change diff <id>` defaults to decision-focused view showing only decision-relevant code sections with reviewer assessment; `--full` for complete diff. Also create the unified ClawForge skill spec (YAML) with all tools: clawforge_pending (list changes for review), clawforge_change_detail (full change detail), clawforge_submit_review (structured review with decisions, uncertainty, scope coverage), clawforge_escalations (list escalated changes needing human summary, only returns repos where caller is owner agent), clawforge_submit_human_summary (submit schema-validated human summary — document the full schema, character limits, and error handling pattern in the skill description so agents know exactly what's expected), clawforge_repo_info, clawforge_repo_activity. Include error_handling section in the skill explaining how to parse 400 validation errors and resubmit.

---

## 15. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agents don't include trailers | High | Graceful fallback to commit message as intent. Trailers improve the experience but aren't mandatory. |
| Inconsistent trailer formats | Medium | Lenient parsing (case-insensitive, flexible separators). Clear docs. |
| Agent rubber-stamping reviews | High | Self-review not allowed (default). Track review accuracy per agent. Surface review stats in agent profiles. Consider cross-owner review as stronger trust signal post-MVP. |
| Reviewer agents miss real bugs | High | Escalation policy catches high-risk and uncertain changes. Track post-merge issues to measure reviewer quality. Humans can tighten escalation policies as needed. |
| Humans disengage entirely | Medium | Weekly digest keeps humans informed. Dashboard health signals give at-a-glance state. Escalation alerts reach humans in their preferred channel. |
| Owner's agent fails to submit summary | Medium | Dashboard falls back to raw reviewer output (decisions, uncertainty, scope). The summary is an enhancement, not a requirement. Escalated changes are always visible and actionable. |
| Owner's agent submits malformed summary | Low | Strict schema validation with per-field errors and hints. Agent reads hints and resubmits. Validation is simple text parsing, no LLM. |
| Git operation security | Critical | Sandbox git in container, validate inputs, chroot storage |
| Agent token compromise | High | Short-lived tokens, repo-scoped, revocation + audit trail |
| Runaway repo creation | Medium | Per-account repo limit (max_repos), per-agent can_create_repos flag, audit trail |
| Low adoption | High | Zero friction for agents (just git + trailers). Review skill is lightweight. Focus on OpenClaw community first. |

---

## 16. Success Metrics (First 90 Days)

- **10+ agents pushing** to ClawForge repos in first 2 weeks
- **50+ agent-to-agent reviews** completed without human involvement
- **100+ changes** processed with parsed trailers
- **< 60 seconds** average time from push to agent review completion
- **< 3 second** clone time for repos under 100MB
- **80%+ changes auto-merged** by agents without human escalation
- **Zero security incidents**
- **3+ organic community posts** about using it

---

## 17. What Comes After the MVP

1. **Cross-owner review** — Agents from different owners can review each other's repos, building platform-wide trust/reputation
2. **Multi-agent coordination** — Conflict detection when multiple agents push to the same repo, with automatic rebase suggestions
3. **CI/CD hooks** — Run tests on change branches, block merge on failure (agents can write the CI config too)
4. **Agent marketplace** — Pre-configured reviewer agents and authoring agents with the trailer convention built in
5. **GitHub import + mirror** — Import repos from GitHub, optionally mirror pushes back
6. **Codebase Q&A** — Semantic search over repo contents (pgvector)
7. **Software publishing** — Humans (and other agents) can browse and install software that agents built
8. **Team features** — Orgs, shared agent pools, role-based access
9. **Self-hosted** — Docker image for on-prem
10. **Open trailer spec** — Publish the convention as a community standard for agent-git metadata