import { pgEnum, pgTable, uuid, varchar, text, timestamp, boolean, integer, jsonb, uniqueIndex, index, bigserial, bigint, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Repos are owned by a USER (human or service-account) or ORG namespace. The
// `agent` value is legacy — repos created before the ownership inversion. New
// repos never use it; the migration flips existing `agent` repos to `user`
// (a same-named service-account). Kept in the enum until no agent repos remain.
export const namespaceType = pgEnum("namespace_type", ["agent", "org", "user"]);
// A `service` user is the headless-agent owner: a user row that owns repos but
// can never sign in (no human). A `human` user is a normal account.
export const userKind = pgEnum("user_kind", ["human", "service"]);
export const changeStatus = pgEnum("change_status", ["draft", "pending", "approved", "changes_requested", "merged", "rolled_back"]);
export const riskLevel = pgEnum("risk_level", ["low", "medium", "high", "critical"]);
export const reviewVerdict = pgEnum("review_verdict", ["approve", "request_changes", "comment"]);
export const reviewerKind = pgEnum("reviewer_kind", ["agent", "human"]);
export const ciStatus = pgEnum("ci_status", ["pending", "running", "success", "failure", "skipped"]);
export const issueStatus = pgEnum("issue_status", ["open", "closed"]);
export const actorKind = pgEnum("actor_kind", ["agent", "human", "system"]);
export const ruleAction = pgEnum("rule_action", ["push", "review", "merge"]);
export const ruleEffect = pgEnum("rule_effect", ["allow", "deny"]);
export const orgRole = pgEnum("org_role", ["admin", "member"]);
export const collaboratorRole = pgEnum("collaborator_role", ["writer", "reviewer"]);
export const mergeMethod = pgEnum("merge_method", ["merge", "squash", "rebase"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 120 }),
  username: varchar("username", { length: 60 }).unique(),
  // `service` users own repos for headless agents and can never sign in.
  kind: userKind("kind").notNull().default("human"),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  totpSecret: varchar("totp_secret", { length: 120 }),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  // Session revocation: user JWTs carry this as the `v` claim; bumping it
  // invalidates every outstanding session (propagates within the token-cache
  // TTL). Tokens minted before the column existed count as v=0.
  tokenVersion: integer("token_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull().unique(),
  tokenHash: varchar("token_hash", { length: 255 }).notNull(),
  claimToken: varchar("claim_token", { length: 120 }),
  // Claim tokens are single-use AND time-boxed: a token leaked from an old
  // log or credentials file is already dead. Null when there is nothing to
  // claim (auto-claimed at registration, or already claimed).
  claimTokenExpiresAt: timestamp("claim_token_expires_at", { withTimezone: true }),
  associatedUserId: uuid("associated_user_id").references(() => users.id, { onDelete: "set null" }),
  // The service-account user that owns this (headless) agent's repos, if any.
  // Set when a same-named service user is provisioned. Links a claimed agent to
  // the service namespace that holds its repos so the human can see them.
  serviceUserId: uuid("service_user_id").references(() => users.id, { onDelete: "set null" }),
  // A personal agent is auto-provisioned for a human so the solo "commit +
  // review my own code" case needs one identity, not two. One per user.
  isPersonal: boolean("is_personal").notNull().default(false),
  gitAuthorName: varchar("git_author_name", { length: 120 }).notNull(),
  gitAuthorEmail: varchar("git_author_email", { length: 255 }).notNull(),
  capabilities: jsonb("capabilities").notNull().default({ push: true, review: false }),
  stats: jsonb("stats").notNull().default({ changesOpened: 0, reviewsSubmitted: 0 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull().unique(),
  displayName: varchar("display_name", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// OAuth identities. One account, many sign-in methods: callback resolution
// is (provider, providerUserId) first — survives email changes at the
// provider — then verified email, which is what merges GitHub + Google +
// password sign-ins that share an address into a single user.
export const userIdentities = pgTable("user_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 40 }).notNull(),
  providerUserId: varchar("provider_user_id", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqProviderUser: uniqueIndex("user_identities_provider_uid_uniq").on(t.provider, t.providerUserId),
}));

export const orgMembers = pgTable("org_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: orgRole("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqMember: uniqueIndex("org_members_uniq").on(t.orgId, t.userId),
}));

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull(),
  namespaceType: namespaceType("namespace_type").notNull(),
  namespaceId: uuid("namespace_id").notNull(),
  description: text("description"),
  defaultBranch: varchar("default_branch", { length: 120 }).notNull().default("main"),
  isPublic: boolean("is_public").notNull().default(false),
  topics: jsonb("topics").notNull().default([]),
  language: varchar("language", { length: 40 }),
  starsCount: integer("stars_count").notNull().default(0),
  watchersCount: integer("watchers_count").notNull().default(0),
  changesCount: integer("changes_count").notNull().default(0),
  mergedThisWeek: integer("merged_this_week").notNull().default(0),
  forkOfRepoId: uuid("fork_of_repo_id"),
  // Production-safe by default: risk is computed from the diff (not just
  // agent-declared), humans gate medium+ effective risk, and code-level review
  // gates high+ (a behavior-only approval does not satisfy the gate there). The
  // agent that opened a Change can never approve its own work
  // (allowSelfReview: false → separation of duties). "Vibecoding" mode —
  // agents auto-merging their own low-risk changes — is a per-repo opt-in.
  // Even then, pathOverrides keep a human in the loop on governance, schema,
  // and deploy changes regardless of declared risk.
  mergePolicy: jsonb("merge_policy").notNull().default({
    requireHumanApproval: "if_risk_at_least",
    requireHumanApprovalLevel: "medium",
    minApprovalsTotal: 1,
    minApprovalsHuman: 0,
    allowSelfReview: false,
    ciRequired: true,
    codeReviewRequiredAtRisk: "high",
    pathOverrides: [
      { glob: ".clawhub/policies/**", requireHuman: true },
      { glob: "**/migrations/**", requireHuman: true },
      { glob: "**/*.sql", requireHuman: true },
      { glob: "deploy/**", requireHuman: true },
      { glob: "**/Dockerfile", requireHuman: true },
      { glob: "docker-compose*.yml", requireHuman: true },
    ],
    trustedAgents: [],
    allowedMergeMethods: ["merge", "squash", "rebase"],
    defaultMergeMethod: "merge",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqName: uniqueIndex("repos_ns_name_uniq").on(t.namespaceType, t.namespaceId, t.name),
  byStars: index("repos_stars_idx").on(t.starsCount),
}));

export const repoCollaborators = pgTable("repo_collaborators", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  role: collaboratorRole("role").notNull().default("writer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqCollab: uniqueIndex("repo_collab_uniq").on(t.repoId, t.agentId),
}));

export const branches = pgTable("branches", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  headCommit: varchar("head_commit", { length: 64 }).notNull(),
  protection: jsonb("protection"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqBranch: uniqueIndex("branches_uniq").on(t.repoId, t.name),
}));

export const changes = pgTable("changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  branch: varchar("branch", { length: 255 }).notNull(),
  headCommit: varchar("head_commit", { length: 64 }).notNull(),
  intent: text("intent").notNull(),
  risk: riskLevel("risk").notNull().default("low"),
  // Risk the server computed from the diff (path taxonomy, size, test coverage,
  // author history). Nullable until the first post-push pass runs. The merge
  // gate uses max(declared risk, computedRisk); riskReasons explains the value.
  computedRisk: varchar("computed_risk", { length: 12 }),
  riskReasons: jsonb("risk_reasons").notNull().default([]),
  // `scope` is what the agent DECLARED (the Scope: trailer, drives review
  // focus). `changedPaths` is what git actually changed (authoritative). The
  // merge gate's sensitive-path forcing reads changedPaths so an agent can't
  // dodge a code-review requirement by under-reporting its Scope: trailer.
  scope: jsonb("scope").notNull().default([]),
  changedPaths: jsonb("changed_paths").notNull().default([]),
  reviewFocus: jsonb("review_focus").notNull().default([]),
  trailers: jsonb("trailers").notNull().default({}),
  status: changeStatus("status").notNull().default("pending"),
  hasConflicts: boolean("has_conflicts").notNull().default(false),
  escalated: boolean("escalated").notNull().default(false),
  escalationReason: text("escalation_reason"),
  openedByAgentId: uuid("opened_by_agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  ciStatus: ciStatus("ci_status").notNull().default("pending"),
  isDraft: boolean("is_draft").notNull().default(false),
  autoMerge: jsonb("auto_merge"),
  requestedReviewers: jsonb("requested_reviewers").notNull().default([]),
  mergedAt: timestamp("merged_at", { withTimezone: true }),
  mergedBy: uuid("merged_by"),
  mergeMethod: mergeMethod("merge_method"),
  mergeCommit: varchar("merge_commit", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqBranch: uniqueIndex("changes_repo_branch_uniq").on(t.repoId, t.branch),
  byRepo: index("changes_repo_idx").on(t.repoId),
  // Dashboards filter by status and sort by recency; without these the
  // triage queries scan the table once agents push at volume.
  byStatus: index("changes_status_idx").on(t.status, t.createdAt),
  byCreated: index("changes_created_idx").on(t.createdAt),
  // The change-list endpoint (routes/changes.ts + ChangeService.listForRepo) is
  // `where repoId order by updatedAt desc`. The bare repoId index above still
  // leaves a sort; this composite serves the ORDER BY directly so the list a
  // human refreshes right after a push returns in index order, no scan+sort.
  byRepoUpdated: index("changes_repo_updated_idx").on(t.repoId, t.updatedAt),
}));

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  changeId: uuid("change_id").notNull().references(() => changes.id, { onDelete: "cascade" }),
  reviewerKind: reviewerKind("reviewer_kind").notNull(),
  reviewerId: uuid("reviewer_id").notNull(),
  verdict: reviewVerdict("verdict").notNull(),
  // What the approval is based on: "behavior" (ran/tested it), "code" (read the
  // diff), or "both". Code review is what satisfies the policy gate at high
  // risk — a behavior-only approval does not count there. Defaults to "code"
  // so reviews predating the column keep counting as code-level.
  basis: varchar("basis", { length: 12 }).notNull().default("code"),
  summary: text("summary"),
  additionalFocus: jsonb("additional_focus").notNull().default([]),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  // Set when a verdict is SUPERSEDED — e.g. reopening a change dismisses a
  // mis-clicked request_changes. A superseded review stays for history but no
  // longer counts toward the merge gate (evaluate filters them out).
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
}, t => ({
  byChange: index("reviews_change_idx").on(t.changeId),
}));

// Evidence a reviewer attaches to PROVE they verified the change — pasted test
// output, CLI output, a screenshot/log URL, or a link to the CI run they relied
// on. Makes "review = run it and show the proof" a first-class artifact instead
// of a claim buried in the summary text. See issue #6.
export const reviewEvidence = pgTable("review_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewId: uuid("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 20 }).notNull(), // test_output | cli_output | screenshot | log | link
  label: varchar("label", { length: 200 }),
  content: text("content"), // inline test/CLI output (capped at insert)
  url: text("url"),         // screenshot / log / external link
  runId: uuid("run_id").references(() => ciRuns.id, { onDelete: "set null" }), // CI run the review leaned on
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byReview: index("review_evidence_review_idx").on(t.reviewId),
}));
export type ReviewEvidence = typeof reviewEvidence.$inferSelect;

export const permissionRules = pgTable("permission_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  pathGlob: varchar("path_glob", { length: 500 }).notNull().default("**"),
  actorKind: actorKind("actor_kind").notNull(),
  actorId: uuid("actor_id"),
  action: ruleAction("action").notNull(),
  effect: ruleEffect("effect").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ciPipelines = pgTable("ci_pipelines", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  yaml: text("yaml").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  // Trigger persisted as a queryable column so the scheduler loop and the event
  // fan-out can index pipelines by kind without re-parsing every repo's YAML on
  // each tick. Derived from the YAML `on:` field at upsert (routes/ci.ts PUT).
  //   push  → runs on every Change push (the test/lint gate; default)
  //   merge → runs at the merge commit (deploy hook)
  //   schedule → cron-driven (triggerConfig.cron, 5-field, UTC)
  //   event → ClawHub event-driven (triggerConfig.event, e.g. "change.merged")
  triggerKind: varchar("trigger_kind", { length: 16 }).notNull().default("push"),
  triggerConfig: jsonb("trigger_config").notNull().default({}),
  // Last cron tick this pipeline fired for. The scheduler de-dups against this
  // with a conditional UPDATE so two overlapping 60s loops cannot double-fire.
  lastScheduledRunAt: timestamp("last_scheduled_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqPipeline: uniqueIndex("ci_pipelines_uniq").on(t.repoId, t.name),
  byTriggerKind: index("ci_pipelines_trigger_idx").on(t.triggerKind),
}));

export const ciRuns = pgTable("ci_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "cascade" }),
  // Nullable: a standing-agent run (origin='agent') has no pipeline — it runs a
  // BYO container image, not a repo CI pipeline. Push/merge/schedule/event runs
  // still carry a pipelineId. See standingAgentId below + docs/standing-agents.md.
  pipelineId: uuid("pipeline_id").references(() => ciPipelines.id, { onDelete: "cascade" }),
  // Set when this run is a standing-agent tick (origin='agent'). The runner reads
  // the standing agent (image/command/limits) and pulls the sealed agent token +
  // LLM creds via the per-run-token secrets endpoint. Null for CI runs.
  standingAgentId: uuid("standing_agent_id").references(() => standingAgents.id, { onDelete: "set null" }),
  status: ciStatus("status").notNull().default("pending"),
  runnerToken: varchar("runner_token", { length: 120 }).notNull(),
  // Loop-guard fields for schedule/event triggers (push/merge leave them null):
  //   origin       — what enqueued the run: "push"|"merge"|"schedule"|"event"|"agent".
  //   triggerDepth — how many trigger hops produced this run. A push is depth 0;
  //                  an event-triggered run carries depth 1; the fan-out refuses
  //                  to enqueue when depth would exceed 1, capping cascades.
  //   triggerEvent — the event type that fired this run (event triggers only).
  //   commit       — the commit SHA the run targets; lets the fan-out de-dup an
  //                  identical (pipeline, commit, triggerEvent) run already live.
  origin: varchar("origin", { length: 16 }),
  triggerDepth: integer("trigger_depth").notNull().default(0),
  triggerEvent: varchar("trigger_event", { length: 64 }),
  commit: varchar("commit", { length: 64 }),
  logUrl: text("log_url"),
  stepResults: jsonb("step_results").notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byChange: index("ci_runs_change_idx").on(t.changeId),
  // Standing-agent in-flight + rate-cap lookups filter by this.
  byStandingAgent: index("ci_runs_standing_idx").on(t.standingAgentId),
  // Speeds the event-trigger de-dup lookup (pipeline + commit + status).
  byPipelineCommit: index("ci_runs_pipeline_commit_idx").on(t.pipelineId, t.commit),
  // Atomic de-dup for event-triggered runs: at most one PENDING run per
  // (pipeline, commit, event). Two concurrent enqueues (multi-replica, or an
  // event double-delivered by the in-process + Redis-poll paths) collide here;
  // the loser catches the unique violation. Scoped to pending + event runs so a
  // later legitimate re-trigger (after the first run leaves pending) still inserts.
  uniqPendingEvent: uniqueIndex("ci_runs_pending_event_uniq")
    .on(t.pipelineId, t.commit, t.triggerEvent)
    .where(sql`status = 'pending' and trigger_event is not null`),
  // Idempotent standing-agent dispatch: at most one PENDING run per standing
  // agent. Two concurrent ticks (overlapping loops, event+continuous, multi
  // replica) collide here — the loser catches 23505 and treats it as
  // already-dispatched. Backstops the per-agent advisory lock in dispatch.
  uniqStandingPending: uniqueIndex("ci_runs_standing_pending_uniq")
    .on(t.standingAgentId)
    .where(sql`status = 'pending' and standing_agent_id is not null`),
}));

// A standing agent: a BYO container image that ClawHub runs continuously, on a
// schedule, or on events, scoped to one repo, acting as `agentId`. ClawHub never
// runs the model — the container does, with the sealed LLM key injected at run
// time. See docs/standing-agents.md. Ticks dispatch as ci_runs(origin='agent').
export const standingAgents = pgTable("standing_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  // The ClawHub agent identity the container pushes/reviews as.
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  image: varchar("image", { length: 500 }).notNull(),
  command: text("command"),
  // manual | continuous | schedule | event
  trigger: varchar("trigger", { length: 16 }).notNull().default("manual"),
  cron: varchar("cron", { length: 120 }),        // schedule trigger (5-field UTC)
  event: varchar("event", { length: 64 }),        // event trigger (e.g. change.merged)
  intervalSec: integer("interval_sec").notNull().default(300), // continuous floor
  // The agent "mode" injected as CLAWHUB_MODE: worker | review | triage | reflect.
  // Different modes feed one memory: worker/review emit episodes, reflect distills
  // them into durable conventions. See docs/memory.md.
  mode: varchar("mode", { length: 16 }).notNull().default("worker"),
  task: text("task").notNull().default(""),       // injected as CLAWHUB_TASK
  llmProvider: varchar("llm_provider", { length: 24 }).notNull().default("anthropic"),
  llmBaseUrl: text("llm_base_url"),
  // Sealed (libsodium) LLM API key + agent push token. NEVER returned by any API;
  // delivered to the claiming runner only via the per-run-token secrets endpoint.
  llmCiphertext: text("llm_ciphertext"),
  llmNonce: varchar("llm_nonce", { length: 120 }),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenNonce: varchar("token_nonce", { length: 120 }).notNull(),
  memoryMb: integer("memory_mb").notNull().default(1024),
  cpus: integer("cpus").notNull().default(1),
  timeoutSec: integer("timeout_sec").notNull().default(1800),
  enabled: boolean("enabled").notNull().default(true),
  // idle | running | error  ("paused" is derived from !enabled in the UI)
  status: varchar("status", { length: 16 }).notNull().default("idle"),
  lastError: text("last_error"),
  // Consecutive failed runs. Drives exponential backoff (continuous) and the
  // circuit breaker that auto-pauses a flapping agent after MAX failures.
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  // When set, a continuous agent is held off until this time (failure backoff).
  nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }),
  lastRunId: uuid("last_run_id"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  // Compare-and-swap marker for the schedule trigger (mirrors ciPipelines).
  lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true }),
  // The Agent Role this instance was deployed from (null = ad-hoc standing agent).
  // Deploying a role to N repos creates N standing_agents sharing one roleId.
  roleId: uuid("role_id").references((): AnyPgColumn => agentRoles.id, { onDelete: "set null" }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqStandingAgent: uniqueIndex("standing_agents_uniq").on(t.repoId, t.name),
  byRepo: index("standing_agents_repo_idx").on(t.repoId),
  byTrigger: index("standing_agents_trigger_idx").on(t.trigger),
  byRole: index("standing_agents_role_idx").on(t.roleId),
}));

// An Agent Role: a deployable agent template. Deploying a Role to a repo (or
// fanning it out across an org) creates standing_agents from this template. A
// reviewer/specialist is just a Role with capability=reviewer. Curated templates
// are system-owned Roles surfaced as the marketplace. See docs/agent-roles.md.
export const roleCapability = pgEnum("role_capability", ["worker", "reviewer", "triager", "specialist"]);

export const agentRoles = pgTable("agent_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  // user | org | system (curated template). ownerId null for system templates.
  ownerType: varchar("owner_type", { length: 8 }).notNull(),
  ownerId: uuid("owner_id"),
  name: varchar("name", { length: 120 }).notNull(),
  slug: varchar("slug", { length: 120 }),          // stable key for templates/marketplace
  description: text("description"),
  capability: roleCapability("capability").notNull().default("worker"),
  specialization: varchar("specialization", { length: 64 }), // security | performance | deps | style | ...
  image: varchar("image", { length: 500 }).notNull(),
  command: text("command"),
  // worker | review | triage | reflect (→ CLAWHUB_MODE). Defaults from capability.
  mode: varchar("mode", { length: 16 }).notNull().default("worker"),
  trigger: varchar("trigger", { length: 16 }).notNull().default("manual"),
  cron: varchar("cron", { length: 120 }),
  event: varchar("event", { length: 64 }),
  intervalSec: integer("interval_sec").notNull().default(3600),
  task: text("task").notNull().default(""),
  llmProvider: varchar("llm_provider", { length: 24 }).notNull().default("anthropic"),
  llmBaseUrl: text("llm_base_url"),
  // The role's dedicated agent + sealed creds (the LLM key + the agent push token).
  // Deployments re-seal these per standing_agent. NEVER returned by any API.
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  llmCiphertext: text("llm_ciphertext"),
  llmNonce: varchar("llm_nonce", { length: 120 }),
  tokenCiphertext: text("token_ciphertext"),
  tokenNonce: varchar("token_nonce", { length: 120 }),
  memoryMb: integer("memory_mb").notNull().default(1024),
  cpus: integer("cpus").notNull().default(1),
  timeoutSec: integer("timeout_sec").notNull().default(1800),
  // Minimum org trust tier required to deploy this role (sandbox|standard|trusted).
  minTrustTier: varchar("min_trust_tier", { length: 16 }).notNull().default("sandbox"),
  // If true, this role's agent can EARN low-risk self-merge once its quality clears
  // the bar (see services/agent-autonomy.ts). Otherwise it always needs review.
  earnedAutonomy: boolean("earned_autonomy").notNull().default(false),
  isTemplate: boolean("is_template").notNull().default(false), // curated template
  isPublic: boolean("is_public").notNull().default(false),     // surfaced in marketplace
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byOwner: index("agent_roles_owner_idx").on(t.ownerType, t.ownerId),
  uniqSlug: uniqueIndex("agent_roles_slug_uniq").on(t.slug).where(sql`slug is not null`),
  byTemplate: index("agent_roles_template_idx").on(t.isTemplate, t.isPublic),
}));

// Agent memory (FIT). One table discriminated by `kind`; ClawHub stores + ranks
// lexically/temporally + scopes + decays, the agent authors the content. ClawHub
// never interprets `body`. See docs/memory.md.
export const memoryKind = pgEnum("memory_kind", ["episode", "convention", "failure", "decision", "expertise"]);
export const memoryScope = pgEnum("memory_scope", ["agent", "repo", "agent_repo", "org"]);

export const agentMemories = pgTable("agent_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Structural auth boundary (resolved server-side, never client-supplied).
  scope: memoryScope("scope").notNull(),
  scopeKey: varchar("scope_key", { length: 160 }).notNull(), // agent:<id> | repo:<id> | agent_repo:<aid>:<rid> | org:<id>
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  // Agent-authored content — ClawHub never interprets `body`.
  kind: memoryKind("kind").notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body").notNull(),
  facts: jsonb("facts").notNull().default({}),  // {paths?, errorFingerprint?, changeId?, mode?, ciResult?, ...}
  tags: jsonb("tags").notNull().default([]),
  // Ranking inputs. importance is a self-rated FLOOR, cross-checked at read time.
  importance: integer("importance").notNull().default(3),
  confidence: integer("confidence").notNull().default(50),
  trigrams: jsonb("trigrams").notNull().default([]),       // extractTrigrams(title+body+tags)
  embedding: text("embedding"),                            // OPTIONAL base64 float32; lexical works without it
  embeddingModel: varchar("embedding_model", { length: 80 }),
  // Bi-temporal (Zep-style): invalidate, don't delete — correct point-in-time answers.
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true }),
  // Self-ref to the row this replaces; set-null on delete so a pruned predecessor
  // doesn't leave a dangling pointer.
  supersedesId: uuid("supersedes_id").references((): AnyPgColumn => agentMemories.id, { onDelete: "set null" }),
  // Recency / decay.
  useCount: integer("use_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  pinned: boolean("pinned").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  // Provenance + governance.
  sourceRunId: uuid("source_run_id").references(() => ciRuns.id, { onDelete: "set null" }),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
  reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byScopeKind: index("agent_memories_scope_kind_idx").on(t.scopeKey, t.kind, t.importance),
  byFingerprint: index("agent_memories_fingerprint_idx").on(t.repoId).where(sql`facts ->> 'errorFingerprint' is not null`),
  // Idempotency: a re-delivered run can't double-write the same note.
  uniqRunKindTitle: uniqueIndex("agent_memories_run_kind_title_uniq").on(t.sourceRunId, t.kind, t.title).where(sql`source_run_id is not null`),
  byDecay: index("agent_memories_decay_idx").on(t.scopeKey, t.lastUsedAt).where(sql`valid_to is null and archived_at is null and pinned = false`),
  bySupersedes: index("agent_memories_supersedes_idx").on(t.supersedesId),
}));

export const issues = pgTable("issues", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  body: text("body"),
  status: issueStatus("status").notNull().default("open"),
  assignedAgentId: uuid("assigned_agent_id").references(() => agents.id, { onDelete: "set null" }),
  labels: jsonb("labels").notNull().default([]),
  milestoneId: uuid("milestone_id"),
  priority: varchar("priority", { length: 20 }).notNull().default("normal"),
  createdByKind: actorKind("created_by_kind").notNull(),
  createdById: uuid("created_by_id").notNull(),
  closingChangeId: uuid("closing_change_id").references(() => changes.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqNum: uniqueIndex("issues_repo_num_uniq").on(t.repoId, t.number),
  byStatus: index("issues_status_idx").on(t.status),
  byMilestone: index("issues_milestone_idx").on(t.milestoneId),
}));

// @-mentions from issues/comments/reviews, surfaced as notifications.
export const mentions = pgTable("mentions", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
  mentionedKind: actorKind("mentioned_kind").notNull(),
  mentionedId: uuid("mentioned_id").notNull(),
  sourceKind: varchar("source_kind", { length: 40 }).notNull(),
  sourceId: uuid("source_id").notNull(),
  authorKind: actorKind("author_kind").notNull(),
  authorId: uuid("author_id").notNull(),
  acknowledged: boolean("acknowledged").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byTarget: index("mentions_target_idx").on(t.mentionedKind, t.mentionedId),
}));

// Durable in-app notification inbox for a HUMAN user. Distinct from `mentions`
// (the per-mention ledger that agents also pull) and from `email_outbox` (the
// email channel): this is the "what happened to me" feed behind the Bell. Each
// row carries a precomputed dashboard-relative `link` so the inbox deep-links
// exactly (the mention row can't, since it only stores the source ROW id). A
// notification is created alongside the email for review-requested + @-mention
// signals; future kinds (change_merged, ci_failure) reuse the same row.
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 40 }).notNull(), // mention | review_requested | change_merged | ci_failure
  title: text("title").notNull(),
  body: text("body"),
  link: text("link"), // dashboard-relative deep link (e.g. /repos/ns/name/changes/<id>)
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
  sourceKind: varchar("source_kind", { length: 40 }),
  sourceId: uuid("source_id"),
  actorKind: actorKind("actor_kind"),
  actorId: uuid("actor_id"),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byUser: index("notifications_user_idx").on(t.userId, t.read, t.createdAt),
}));
export type Notification = typeof notifications.$inferSelect;

export const issueComments = pgTable("issue_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  authorKind: actorKind("author_kind").notNull(),
  authorId: uuid("author_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// N:M links between issues and changes ("this PR fixes this issue", and vice
// versa). The `Closes: #N` trailer auto-links on merge; humans can also link
// explicitly. Distinct from issues.closingChangeId (the single change that
// auto-CLOSED the issue) — an issue can be linked to many changes. Issue #13.
export const issueChanges = pgTable("issue_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  changeId: uuid("change_id").notNull().references(() => changes.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byIssue: index("issue_changes_issue_idx").on(t.issueId),
  byChange: index("issue_changes_change_idx").on(t.changeId),
  uniq: uniqueIndex("issue_changes_uniq").on(t.issueId, t.changeId),
}));
export type IssueChange = typeof issueChanges.$inferSelect;

export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  ciphertext: text("ciphertext").notNull(),
  nonce: varchar("nonce", { length: 120 }).notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqSecret: uniqueIndex("secrets_uniq").on(t.repoId, t.name),
}));

export const releases = pgTable("releases", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  tag: varchar("tag", { length: 255 }).notNull(),
  title: varchar("title", { length: 500 }),
  body: text("body"),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqTag: uniqueIndex("releases_repo_tag_uniq").on(t.repoId, t.tag),
}));

export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secret: varchar("secret", { length: 255 }).notNull(),
  events: jsonb("events").notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
  actorKind: actorKind("actor_kind").notNull(),
  actorId: uuid("actor_id"),
  action: varchar("action", { length: 120 }).notNull(),
  category: varchar("category", { length: 40 }).notNull().default("other"),
  metadata: jsonb("metadata").notNull().default({}),
  ip: varchar("ip", { length: 64 }),
  userAgent: varchar("user_agent", { length: 500 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRepo: index("audit_repo_idx").on(t.repoId),
  byCreated: index("audit_created_idx").on(t.createdAt),
  byAction: index("audit_action_idx").on(t.action),
}));

// Inline review comments: per-file-per-line threads, resolvable.
export const reviewComments = pgTable("review_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  changeId: uuid("change_id").notNull().references(() => changes.id, { onDelete: "cascade" }),
  threadId: uuid("thread_id").notNull(),
  parentId: uuid("parent_id"),
  path: varchar("path", { length: 500 }).notNull(),
  line: integer("line").notNull(),
  side: varchar("side", { length: 8 }).notNull().default("new"),
  body: text("body").notNull(),
  suggestion: text("suggestion"),
  authorKind: actorKind("author_kind").notNull(),
  authorId: uuid("author_id").notNull(),
  resolved: boolean("resolved").notNull().default(false),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: uuid("resolved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byChange: index("review_comments_change_idx").on(t.changeId),
  byThread: index("review_comments_thread_idx").on(t.threadId),
}));

// Milestones for issues.
export const milestones = pgTable("milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqTitle: uniqueIndex("milestones_repo_title_uniq").on(t.repoId, t.title),
}));

// Issue templates for repos.
export const issueTemplates = pgTable("issue_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  title: varchar("title", { length: 500 }).notNull().default(""),
  body: text("body").notNull().default(""),
  labels: jsonb("labels").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqName: uniqueIndex("issue_templates_uniq").on(t.repoId, t.name),
}));


// Release assets (e.g. binaries, archives).
export const releaseAssets = pgTable("release_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  releaseId: uuid("release_id").notNull().references(() => releases.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  contentType: varchar("content_type", { length: 200 }).notNull().default("application/octet-stream"),
  size: integer("size").notNull().default(0),
  url: text("url").notNull(),
  checksum: varchar("checksum", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqName: uniqueIndex("release_assets_uniq").on(t.releaseId, t.name),
}));

// CI artifacts produced by runs.
export const ciArtifacts = pgTable("ci_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => ciRuns.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  contentType: varchar("content_type", { length: 200 }).notNull().default("application/octet-stream"),
  size: integer("size").notNull().default(0),
  url: text("url").notNull(),
  checksum: varchar("checksum", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRun: index("ci_artifacts_run_idx").on(t.runId),
}));

// Per-agent rate-limit usage + scope enforcement.
export const agentQuotas = pgTable("agent_quotas", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }).unique(),
  pushPerHour: integer("push_per_hour").notNull().default(60),
  reviewPerHour: integer("review_per_hour").notNull().default(120),
  apiPerHour: integer("api_per_hour").notNull().default(1000),
  maxLocPerChange: integer("max_loc_per_change").notNull().default(0),
  pathAllowlist: jsonb("path_allowlist").notNull().default([]),
  pathDenylist: jsonb("path_denylist").notNull().default([]),
  riskCeiling: riskLevel("risk_ceiling").notNull().default("critical"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentUsage = pgTable("agent_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  window: varchar("window", { length: 40 }).notNull(),
  kind: varchar("kind", { length: 20 }).notNull(),
  count: integer("count").notNull().default(0),
}, t => ({
  uniqWindow: uniqueIndex("agent_usage_uniq").on(t.agentId, t.window, t.kind),
}));

// Agent followers + repo watchers + agent reputation.
export const agentFollowers = pgTable("agent_followers", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqFollow: uniqueIndex("agent_followers_uniq").on(t.agentId, t.userId),
}));

export const repoWatchers = pgTable("repo_watchers", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqWatch: uniqueIndex("repo_watchers_uniq").on(t.repoId, t.userId),
}));

export const repoStars = pgTable("repo_stars", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqStar: uniqueIndex("repo_stars_uniq").on(t.repoId, t.userId),
}));

// Notification preferences.
export const notificationPrefs = pgTable("notification_prefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }).unique(),
  email: boolean("email").notNull().default(true),
  emailOnMention: boolean("email_on_mention").notNull().default(true),
  emailOnReviewRequested: boolean("email_on_review_requested").notNull().default(true),
  emailOnChangeMerged: boolean("email_on_change_merged").notNull().default(true),
  emailOnCiFailure: boolean("email_on_ci_failure").notNull().default(true),
  digestFrequency: varchar("digest_frequency", { length: 20 }).notNull().default("never"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Outbound email queue (for stub or future wiring).
export const emailOutbox = pgTable("email_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  toEmail: varchar("to_email", { length: 255 }).notNull(),
  subject: varchar("subject", { length: 500 }).notNull(),
  body: text("body").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byStatus: index("email_outbox_status_idx").on(t.status),
}));

// Public event log (for /trending + changelog + RSS). Lightweight materialized view.
export const publicActivity = pgTable("public_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  kind: varchar("kind", { length: 40 }).notNull(),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "set null" }),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byCreated: index("public_activity_created_idx").on(t.createdAt),
  byRepo: index("public_activity_repo_idx").on(t.repoId),
  byAgent: index("public_activity_agent_idx").on(t.agentId),
}));

// Changelog entries for the product itself (surfaced at /changelog).
export const changelogEntries = pgTable("changelog_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 500 }).notNull(),
  body: text("body").notNull(),
  tag: varchar("tag", { length: 100 }),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
});

// SSO providers (per-org OIDC or SAML). Admins attach these to their org.
export const ssoProviderKind = pgEnum("sso_provider_kind", ["oidc", "saml"]);

export const ssoProviders = pgTable("sso_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: ssoProviderKind("kind").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  // OIDC: issuer, clientId, clientSecret, scopes
  // SAML: entityId, ssoUrl, x509cert (PEM), audience
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqOrgName: uniqueIndex("sso_providers_uniq").on(t.orgId, t.name),
}));

export const ssoStates = pgTable("sso_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  state: varchar("state", { length: 64 }).notNull().unique(),
  providerId: uuid("provider_id").notNull().references(() => ssoProviders.id, { onDelete: "cascade" }),
  codeVerifier: varchar("code_verifier", { length: 128 }),
  redirectTo: varchar("redirect_to", { length: 500 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Git LFS: objects stored on disk; the table is the index + pointer.
export const lfsObjects = pgTable("lfs_objects", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  oid: varchar("oid", { length: 128 }).notNull(),
  size: integer("size").notNull(),
  uploaded: boolean("uploaded").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqObj: uniqueIndex("lfs_objects_uniq").on(t.repoId, t.oid),
}));

// Package registry: generic + npm-shaped. Files live on disk; this is the index.
export const packageKind = pgEnum("package_kind", ["generic", "npm", "oci", "maven", "pypi"]);

export const packages = pgTable("packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  kind: packageKind("kind").notNull().default("generic"),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqPkg: uniqueIndex("packages_uniq").on(t.repoId, t.kind, t.name),
}));

export const packageVersions = pgTable("package_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  packageId: uuid("package_id").notNull().references(() => packages.id, { onDelete: "cascade" }),
  version: varchar("version", { length: 120 }).notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqVer: uniqueIndex("package_versions_uniq").on(t.packageId, t.version),
}));

export const packageFiles = pgTable("package_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id").notNull().references(() => packageVersions.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  contentType: varchar("content_type", { length: 200 }).notNull().default("application/octet-stream"),
  size: integer("size").notNull().default(0),
  shasum: varchar("shasum", { length: 128 }),
  path: text("path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqFile: uniqueIndex("package_files_uniq").on(t.versionId, t.name),
}));

// Security: dependency advisories (imported from a feed) + per-repo findings.
export const vulnSeverity = pgEnum("vuln_severity", ["low", "medium", "high", "critical"]);

export const vulnAdvisories = pgTable("vuln_advisories", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: varchar("identifier", { length: 64 }).notNull().unique(),
  ecosystem: varchar("ecosystem", { length: 40 }).notNull(),
  packageName: varchar("package_name", { length: 255 }).notNull(),
  vulnerableRange: varchar("vulnerable_range", { length: 255 }).notNull(),
  patchedRange: varchar("patched_range", { length: 255 }),
  severity: vulnSeverity("severity").notNull().default("medium"),
  summary: text("summary").notNull(),
  url: text("url"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byPkg: index("vuln_advisories_pkg_idx").on(t.ecosystem, t.packageName),
}));

export const vulnFindings = pgTable("vuln_findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  advisoryId: uuid("advisory_id").notNull().references(() => vulnAdvisories.id, { onDelete: "cascade" }),
  manifestPath: varchar("manifest_path", { length: 500 }).notNull(),
  installedVersion: varchar("installed_version", { length: 120 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqFinding: uniqueIndex("vuln_findings_uniq").on(t.repoId, t.advisoryId, t.manifestPath),
}));

// SAST rules + findings.
export const sastRules = pgTable("sast_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "cascade" }), // null = global
  identifier: varchar("identifier", { length: 64 }).notNull(),
  pattern: text("pattern").notNull(),
  flags: varchar("flags", { length: 20 }).notNull().default("m"),
  severity: vulnSeverity("severity").notNull().default("medium"),
  message: text("message").notNull(),
  languages: jsonb("languages").notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqRule: uniqueIndex("sast_rules_uniq").on(t.repoId, t.identifier),
}));

export const sastFindings = pgTable("sast_findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "cascade" }),
  ruleId: uuid("rule_id").notNull().references(() => sastRules.id, { onDelete: "cascade" }),
  path: varchar("path", { length: 500 }).notNull(),
  line: integer("line").notNull(),
  excerpt: text("excerpt"),
  severity: vulnSeverity("severity").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byChange: index("sast_findings_change_idx").on(t.changeId),
}));

// Fork / cross-repo: already have repositories.forkOfRepoId. Add a target per change.
export const crossRepoProposals = pgTable("cross_repo_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  changeId: uuid("change_id").notNull().references(() => changes.id, { onDelete: "cascade" }).unique(),
  targetRepoId: uuid("target_repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  targetBranch: varchar("target_branch", { length: 255 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Metrics counters (for /metrics or dashboards). Aggregated hourly.
export const metricsCounters = pgTable("metrics_counters", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull(),
  window: varchar("window", { length: 40 }).notNull(),
  count: integer("count").notNull().default(0),
}, t => ({
  uniqMetric: uniqueIndex("metrics_counters_uniq").on(t.name, t.window),
}));

// Agent provenance attestations — which model + prompt + framework produced a commit.
export const attestations = pgTable("attestations", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "cascade" }),
  commitSha: varchar("commit_sha", { length: 64 }).notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  agentVersion: varchar("agent_version", { length: 60 }),
  modelName: varchar("model_name", { length: 120 }),
  modelVersion: varchar("model_version", { length: 120 }),
  promptHash: varchar("prompt_hash", { length: 128 }),
  framework: varchar("framework", { length: 120 }),
  toolsUsed: jsonb("tools_used").notNull().default([]),
  testsRun: boolean("tests_run").notNull().default(false),
  typechecked: boolean("typechecked").notNull().default(false),
  signature: text("signature"),
  signingKeyId: varchar("signing_key_id", { length: 120 }),
  extra: jsonb("extra").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byCommit: index("attestations_commit_idx").on(t.commitSha),
  byAgent: index("attestations_agent_idx").on(t.agentId),
}));

// Agent versions — treat agents as software that changes.
export const agentVersions = pgTable("agent_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  version: varchar("version", { length: 60 }).notNull(),
  modelName: varchar("model_name", { length: 120 }),
  promptHash: varchar("prompt_hash", { length: 128 }),
  notes: text("notes"),
  trustTier: varchar("trust_tier", { length: 20 }).notNull().default("untrusted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqVersion: uniqueIndex("agent_versions_uniq").on(t.agentId, t.version),
}));

// Eval suites — canary tasks run before promoting an agent version to higher trust.
export const evalSuites = pgTable("eval_suites", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull().unique(),
  description: text("description"),
  cases: jsonb("cases").notNull().default([]),
  passingThreshold: integer("passing_threshold").notNull().default(80),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evalRuns = pgTable("eval_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  suiteId: uuid("suite_id").notNull().references(() => evalSuites.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  agentVersionId: uuid("agent_version_id").references(() => agentVersions.id, { onDelete: "set null" }),
  status: varchar("status", { length: 20 }).notNull().default("queued"),
  score: integer("score"),
  results: jsonb("results").notNull().default([]),
  // Auto-promotion provenance: when a passing run lifts the version's trust tier
  // (capped at the anti-gaming ceiling — see services/trust-tiers.ts), record
  // the transition so the Evals tab can surface "auto-promoted untrusted →
  // sandbox via <suite>". Null when the run did not move a tier.
  promotedFrom: varchar("promoted_from", { length: 20 }),
  promotedTo: varchar("promoted_to", { length: 20 }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Sandboxed execution — containers for agents to test changes.
export const sandboxStatus = pgEnum("sandbox_status", ["pending", "running", "finished", "failed", "killed"]);

export const sandboxes = pgTable("sandboxes", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  ref: varchar("ref", { length: 255 }),
  image: varchar("image", { length: 255 }).notNull().default("node:20-slim"),
  command: text("command").notNull(),
  status: sandboxStatus("status").notNull().default("pending"),
  containerId: varchar("container_id", { length: 80 }),
  stdout: text("stdout").notNull().default(""),
  stderr: text("stderr").notNull().default(""),
  exitCode: integer("exit_code"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Cost ledger — per-change token + $ accounting, ingested by agents when they commit.
export const costLedger = pgTable("cost_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "cascade" }),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cachedTokens: integer("cached_tokens").notNull().default(0),
  costCents: integer("cost_cents").notNull().default(0),
  model: varchar("model", { length: 120 }),
  kind: varchar("kind", { length: 40 }).notNull().default("change"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byAgent: index("cost_ledger_agent_idx").on(t.agentId),
  byRepo: index("cost_ledger_repo_idx").on(t.repoId),
  byCreated: index("cost_ledger_created_idx").on(t.createdAt),
}));

export const costBudgets = pgTable("cost_budgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  monthlyLimitCents: integer("monthly_limit_cents").notNull().default(0),
  hardLimit: boolean("hard_limit").notNull().default(false),
  alertAtPercent: integer("alert_at_percent").notNull().default(80),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Kill switches — suspend an agent across all repos.
export const killSwitches = pgTable("kill_switches", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }).unique(),
  reason: text("reason"),
  engagedBy: uuid("engaged_by"),
  engagedAt: timestamp("engaged_at", { withTimezone: true }).notNull().defaultNow(),
});

// Rollout flags / feature flags.
export const featureFlags = pgTable("feature_flags", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
  key: varchar("key", { length: 120 }).notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(false),
  rolloutPercent: integer("rollout_percent").notNull().default(0),
  rules: jsonb("rules").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqKey: uniqueIndex("feature_flags_uniq").on(t.repoId, t.key),
}));

// Agent-to-agent messages (inbox per agent).
export const agentMessages = pgTable("agent_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  toAgentId: uuid("to_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  fromKind: actorKind("from_kind").notNull(),
  fromId: uuid("from_id").notNull(),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 40 }).notNull().default("feedback"),
  body: jsonb("body").notNull().default({}),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRecipient: index("agent_messages_to_idx").on(t.toAgentId, t.read),
}));

// Durable webhook queue + DLQ.
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  webhookId: uuid("webhook_id").notNull().references(() => webhooks.id, { onDelete: "cascade" }),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, t => ({
  byStatus: index("webhook_deliveries_status_idx").on(t.status, t.nextAttemptAt),
}));

// GDPR export/deletion requests.
export const gdprRequests = pgTable("gdpr_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  downloadUrl: text("download_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// Signing keys for commit/webhook signature (rotation-friendly).
export const signingKeys = pgTable("signing_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  keyId: varchar("key_id", { length: 120 }).notNull().unique(),
  kind: varchar("kind", { length: 20 }).notNull().default("ed25519"),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  active: boolean("active").notNull().default(true),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Code search index — trigram table per repo.
export const codeIndexShards = pgTable("code_index_shards", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  commitSha: varchar("commit_sha", { length: 64 }).notNull(),
  path: text("path").notNull(),
  trigrams: jsonb("trigrams").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqShard: uniqueIndex("code_index_shards_uniq").on(t.repoId, t.path),
}));

// Presence (real-time collab on changes).
export const presenceHeartbeats = pgTable("presence_heartbeats", {
  id: uuid("id").primaryKey().defaultRandom(),
  changeId: uuid("change_id").notNull().references(() => changes.id, { onDelete: "cascade" }),
  actorKind: actorKind("actor_kind").notNull(),
  actorId: uuid("actor_id").notNull(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniq: uniqueIndex("presence_uniq").on(t.changeId, t.actorKind, t.actorId),
}));

// Org-level agent registry — curated agents per org with signing keys + trust tier.
export const orgAgentRegistry = pgTable("org_agent_registry", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  trustTier: varchar("trust_tier", { length: 20 }).notNull().default("sandbox"),
  approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniq: uniqueIndex("org_agent_registry_uniq").on(t.orgId, t.agentId),
}));

// Jira/Linear external issue links.
export const externalIssueLinks = pgTable("external_issue_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
  system: varchar("system", { length: 20 }).notNull(),
  externalKey: varchar("external_key", { length: 120 }).notNull(),
  url: text("url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniq: uniqueIndex("external_issue_links_uniq").on(t.repoId, t.system, t.externalKey),
}));

// Quality scores per agent (computed + cached).
export const agentQualityScores = pgTable("agent_quality_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }).unique(),
  mergeRate: integer("merge_rate").notNull().default(0),
  revertRate: integer("revert_rate").notNull().default(0),
  timeToGreenCiP50: integer("time_to_green_ci_p50").notNull().default(0),
  reviewHitRate: integer("review_hit_rate").notNull().default(0),
  driftScore: integer("drift_score").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// SBOM exports stored per-release.
export const sbomExports = pgTable("sbom_exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  releaseId: uuid("release_id").notNull().references(() => releases.id, { onDelete: "cascade" }),
  format: varchar("format", { length: 20 }).notNull().default("spdx-json"),
  document: jsonb("document").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Password reset + email verification tokens.
export const passwordResets = pgTable("password_resets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 255 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const emailVerifications = pgTable("email_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 255 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Brute-force login attempt tracking.
export const loginAttempts = pgTable("login_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull(),
  ip: varchar("ip", { length: 64 }),
  success: boolean("success").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byEmail: index("login_attempts_email_idx").on(t.email, t.createdAt),
}));

// Team invites + trials.
export const orgInvites = pgTable("org_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 255 }).notNull(),
  role: orgRole("role").notNull().default("member"),
  tokenHash: varchar("token_hash", { length: 255 }).notNull(),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgTrials = pgTable("org_trials", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).unique(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  plan: varchar("plan", { length: 40 }).notNull().default("team"),
});

// Stripe-style subscription record. Actual billing events come from Stripe webhooks.
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  plan: varchar("plan", { length: 40 }).notNull().default("free"),
  status: varchar("status", { length: 40 }).notNull().default("active"),
  stripeCustomerId: varchar("stripe_customer_id", { length: 80 }),
  stripeSubscriptionId: varchar("stripe_subscription_id", { length: 80 }),
  seats: integer("seats").notNull().default(0),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Agent marketplace: curated public agents discoverable by everyone.
export const marketplaceAgents = pgTable("marketplace_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  name: varchar("name", { length: 120 }).notNull(),
  tagline: varchar("tagline", { length: 240 }),
  description: text("description"),
  capabilities: jsonb("capabilities").notNull().default([]),
  pricingModel: varchar("pricing_model", { length: 40 }).notNull().default("free"),
  publisherUserId: uuid("publisher_user_id").references(() => users.id, { onDelete: "set null" }),
  verified: boolean("verified").notNull().default(false),
  installs: integer("installs").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const marketplaceInstalls = pgTable("marketplace_installs", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketplaceAgentId: uuid("marketplace_agent_id").notNull().references(() => marketplaceAgents.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
  installedBy: uuid("installed_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// CI build cache. Keyed by sha256 of cache key.
export const buildCache = pgTable("build_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  cacheKey: varchar("cache_key", { length: 255 }).notNull(),
  storagePath: text("storage_path").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqKey: uniqueIndex("build_cache_uniq").on(t.repoId, t.cacheKey),
}));

// Deployment records tied to merged Changes.
export const deployments = pgTable("deployments", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "set null" }),
  environment: varchar("environment", { length: 60 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  url: text("url"),
  deployedAt: timestamp("deployed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byEnv: index("deployments_env_idx").on(t.repoId, t.environment),
}));

// Status-page incidents.
export const statusIncidents = pgTable("status_incidents", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body").notNull(),
  severity: varchar("severity", { length: 20 }).notNull().default("minor"),
  status: varchar("status", { length: 20 }).notNull().default("investigating"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// CRM leads (demo / contact sales).
export const crmLeads = pgTable("crm_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 160 }),
  company: varchar("company", { length: 200 }),
  source: varchar("source", { length: 80 }).notNull().default("web"),
  note: text("note"),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Git tier sharding (Phase 3/4): catalog of git-service shards + the
// repo→shard placement map. The Node router consults `repoShards` for each
// git operation; a missing row means "use the local fallback" so the system
// stays operational without ever provisioning a shard.
export const gitShards = pgTable("git_shards", {
  id: varchar("id", { length: 120 }).primaryKey(),
  endpoint: varchar("endpoint", { length: 500 }).notNull(),
  // "primary" — accepts writes; "replica" — read-only follower.
  role: varchar("role", { length: 20 }).notNull().default("primary"),
  status: varchar("status", { length: 20 }).notNull().default("healthy"),
  leaseHolder: varchar("lease_holder", { length: 200 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const repoShards = pgTable("repo_shards", {
  repoId: uuid("repo_id").primaryKey().references(() => repositories.id, { onDelete: "cascade" }),
  primaryShardId: varchar("primary_shard_id", { length: 120 }).notNull().references(() => gitShards.id, { onDelete: "restrict" }),
  replicaShardIds: jsonb("replica_shard_ids").notNull().default([]),
  // "active" | "migrating" | "read_only"
  status: varchar("status", { length: 20 }).notNull().default("active"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Phase 4 — Postgres-as-WAL for refs. The receive-pack pre-receive hook on a
// shard writes here BEFORE applying the ref locally; if the insert fails the
// push is rejected. Replicas tail this table to apply ref changes locally.
export const refLog = pgTable("ref_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  refName: varchar("ref_name", { length: 500 }).notNull(),
  oldSha: varchar("old_sha", { length: 64 }).notNull(),
  newSha: varchar("new_sha", { length: 64 }).notNull(),
  shardId: varchar("shard_id", { length: 120 }).notNull(),
  // Optional: which agent push produced this update. Useful for audit + replay.
  agentId: uuid("agent_id"),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRepoSeq: index("ref_log_repo_idx").on(t.repoId, t.id),
  byShard: index("ref_log_shard_idx").on(t.shardId, t.id),
}));

// Per-(shard, repo) replication progress. Replicas use this to resume after
// restart and to advertise whether they're caught up enough to be promoted.
export const shardReplicationState = pgTable("shard_replication_state", {
  shardId: varchar("shard_id", { length: 120 }).notNull(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  lastSeqApplied: bigint("last_seq_applied", { mode: "number" }).notNull().default(0),
  lastAppliedAt: timestamp("last_applied_at", { withTimezone: true }),
  // "healthy" | "lagging" | "degraded" | "stopped"
  status: varchar("status", { length: 20 }).notNull().default("healthy"),
  lastError: text("last_error"),
}, t => ({
  pk: uniqueIndex("shard_replication_state_pk").on(t.shardId, t.repoId),
}));

// Resumable repo migrations between shards.
export const repoMigrations = pgTable("repo_migrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  fromShardId: varchar("from_shard_id", { length: 120 }).notNull(),
  toShardId: varchar("to_shard_id", { length: 120 }).notNull(),
  // "queued" | "cloning" | "tailing" | "cutover" | "cleanup" | "done" | "failed"
  state: varchar("state", { length: 20 }).notNull().default("queued"),
  lastSeqApplied: bigint("last_seq_applied", { mode: "number" }).notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRepo: index("repo_migrations_repo_idx").on(t.repoId),
  byState: index("repo_migrations_state_idx").on(t.state),
}));

// Periodic S3 backups. One row per successful manifest write.
export const repoBackups = pgTable("repo_backups", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  shardId: varchar("shard_id", { length: 120 }).notNull(),
  manifestKey: varchar("manifest_key", { length: 1000 }).notNull(),
  refsKey: varchar("refs_key", { length: 1000 }).notNull(),
  parentBackupId: uuid("parent_backup_id"),
  bytesUploaded: bigint("bytes_uploaded", { mode: "number" }).notNull().default(0),
  packCount: integer("pack_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRepo: index("repo_backups_repo_idx").on(t.repoId, t.createdAt),
}));

export type User = typeof users.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type Change = typeof changes.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type ReviewComment = typeof reviewComments.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type IssueTemplate = typeof issueTemplates.$inferSelect;
export type CiRun = typeof ciRuns.$inferSelect;
export type CiPipeline = typeof ciPipelines.$inferSelect;
export type StandingAgent = typeof standingAgents.$inferSelect;
export type AgentRole = typeof agentRoles.$inferSelect;
export type AgentMemory = typeof agentMemories.$inferSelect;
export type CiArtifact = typeof ciArtifacts.$inferSelect;
export type Secret = typeof secrets.$inferSelect;
export type ReleaseAsset = typeof releaseAssets.$inferSelect;
export type AgentQuota = typeof agentQuotas.$inferSelect;
export type NotificationPref = typeof notificationPrefs.$inferSelect;
export type PublicActivity = typeof publicActivity.$inferSelect;
export type ChangelogEntry = typeof changelogEntries.$inferSelect;
export type SsoProvider = typeof ssoProviders.$inferSelect;
export type LfsObject = typeof lfsObjects.$inferSelect;
export type Package = typeof packages.$inferSelect;
export type PackageVersion = typeof packageVersions.$inferSelect;
export type PackageFile = typeof packageFiles.$inferSelect;
export type VulnAdvisory = typeof vulnAdvisories.$inferSelect;
export type VulnFinding = typeof vulnFindings.$inferSelect;
export type SastRule = typeof sastRules.$inferSelect;
export type SastFinding = typeof sastFindings.$inferSelect;
export type CrossRepoProposal = typeof crossRepoProposals.$inferSelect;
export type Attestation = typeof attestations.$inferSelect;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type EvalSuite = typeof evalSuites.$inferSelect;
export type EvalRun = typeof evalRuns.$inferSelect;
export type Sandbox = typeof sandboxes.$inferSelect;
export type CostLedgerRow = typeof costLedger.$inferSelect;
export type CostBudget = typeof costBudgets.$inferSelect;
export type KillSwitch = typeof killSwitches.$inferSelect;
export type FeatureFlag = typeof featureFlags.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type GdprRequest = typeof gdprRequests.$inferSelect;
export type SigningKey = typeof signingKeys.$inferSelect;
export type AgentQualityScore = typeof agentQualityScores.$inferSelect;
export type SbomExport = typeof sbomExports.$inferSelect;
export type PasswordReset = typeof passwordResets.$inferSelect;
export type EmailVerification = typeof emailVerifications.$inferSelect;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type OrgInvite = typeof orgInvites.$inferSelect;
export type OrgTrial = typeof orgTrials.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type MarketplaceAgent = typeof marketplaceAgents.$inferSelect;
export type MarketplaceInstall = typeof marketplaceInstalls.$inferSelect;
export type BuildCache = typeof buildCache.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type StatusIncident = typeof statusIncidents.$inferSelect;
export type CrmLead = typeof crmLeads.$inferSelect;
export type GitShard = typeof gitShards.$inferSelect;
export type RepoShard = typeof repoShards.$inferSelect;
export type RefLogEntry = typeof refLog.$inferSelect;
export type ShardReplicationState = typeof shardReplicationState.$inferSelect;
export type RepoMigration = typeof repoMigrations.$inferSelect;
export type RepoBackup = typeof repoBackups.$inferSelect;
