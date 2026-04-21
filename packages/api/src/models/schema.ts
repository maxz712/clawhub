import { pgEnum, pgTable, uuid, varchar, text, timestamp, boolean, integer, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const namespaceType = pgEnum("namespace_type", ["agent", "org"]);
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
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  totpSecret: varchar("totp_secret", { length: 120 }),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull().unique(),
  tokenHash: varchar("token_hash", { length: 255 }).notNull(),
  claimToken: varchar("claim_token", { length: 120 }),
  associatedUserId: uuid("associated_user_id").references(() => users.id, { onDelete: "set null" }),
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
  mergePolicy: jsonb("merge_policy").notNull().default({
    requireHumanApproval: "if_risk_at_least",
    requireHumanApprovalLevel: "high",
    minApprovalsTotal: 1,
    minApprovalsHuman: 0,
    allowSelfReview: false,
    ciRequired: false,
    pathOverrides: [],
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
  scope: jsonb("scope").notNull().default([]),
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
}));

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  changeId: uuid("change_id").notNull().references(() => changes.id, { onDelete: "cascade" }),
  reviewerKind: reviewerKind("reviewer_kind").notNull(),
  reviewerId: uuid("reviewer_id").notNull(),
  verdict: reviewVerdict("verdict").notNull(),
  summary: text("summary"),
  additionalFocus: jsonb("additional_focus").notNull().default([]),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byChange: index("reviews_change_idx").on(t.changeId),
}));

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqPipeline: uniqueIndex("ci_pipelines_uniq").on(t.repoId, t.name),
}));

export const ciRuns = pgTable("ci_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "cascade" }),
  pipelineId: uuid("pipeline_id").notNull().references(() => ciPipelines.id, { onDelete: "cascade" }),
  status: ciStatus("status").notNull().default("pending"),
  runnerToken: varchar("runner_token", { length: 120 }).notNull(),
  logUrl: text("log_url"),
  stepResults: jsonb("step_results").notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byChange: index("ci_runs_change_idx").on(t.changeId),
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

export const issueComments = pgTable("issue_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  authorKind: actorKind("author_kind").notNull(),
  authorId: uuid("author_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
