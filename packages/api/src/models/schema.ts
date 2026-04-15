import { pgEnum, pgTable, uuid, varchar, text, timestamp, boolean, integer, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const namespaceType = pgEnum("namespace_type", ["agent", "org"]);
export const changeStatus = pgEnum("change_status", ["pending", "approved", "changes_requested", "merged", "rolled_back"]);
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

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 120 }),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
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
  mergePolicy: jsonb("merge_policy").notNull().default({
    requireHumanApproval: "if_risk_at_least",
    requireHumanApprovalLevel: "high",
    minApprovalsTotal: 1,
    minApprovalsHuman: 0,
    allowSelfReview: false,
    ciRequired: false,
    pathOverrides: [],
    trustedAgents: [],
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqName: uniqueIndex("repos_ns_name_uniq").on(t.namespaceType, t.namespaceId, t.name),
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
  createdByKind: actorKind("created_by_kind").notNull(),
  createdById: uuid("created_by_id").notNull(),
  closingChangeId: uuid("closing_change_id").references(() => changes.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqNum: uniqueIndex("issues_repo_num_uniq").on(t.repoId, t.number),
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
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type Change = typeof changes.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type CiRun = typeof ciRuns.$inferSelect;
export type CiPipeline = typeof ciPipelines.$inferSelect;
export type Secret = typeof secrets.$inferSelect;
