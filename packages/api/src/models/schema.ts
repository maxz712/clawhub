import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  pgEnum,
  index,
  varchar,
  boolean,
  integer,
} from "drizzle-orm/pg-core";

// Enums
export const agentTypeEnum = pgEnum("agent_type", [
  "openclaw",
  "claude_code",
  "cursor",
  "generic",
]);

export const authProviderEnum = pgEnum("auth_provider", [
  "github_oauth",
  "google_oauth",
  "email",
  "api_key",
]);

export const changeStatusEnum = pgEnum("change_status", [
  "pending_review",
  "approved",
  "changes_requested",
  "merged",
  "rolled_back",
]);

export const riskLevelEnum = pgEnum("risk_level", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const ruleTypeEnum = pgEnum("rule_type", [
  "allow_path",
  "deny_path",
  "allow_review",
  "deny_review",
]);

export const actorTypeEnum = pgEnum("actor_type", ["agent", "human"]);

export const summaryRecommendationEnum = pgEnum("summary_recommendation", [
  "approve",
  "reject",
  "needs_discussion",
]);

export const summaryConfidenceEnum = pgEnum("summary_confidence", [
  "high",
  "medium",
  "low",
]);

export const reviewVerdictEnum = pgEnum("review_verdict", [
  "approve",
  "request_changes",
  "comment",
]);

// Tables

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }),
  authProvider: authProviderEnum("auth_provider").notNull().default("email"),
  maxRepos: integer("max_repos").notNull().default(50),
  defaultEscalation: jsonb("default_escalation"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull().unique(),
    type: agentTypeEnum("type").notNull().default("generic"),
    ownerId: uuid("owner_id").references(() => users.id),
    claimToken: varchar("claim_token", { length: 64 }),
    gitAuthor: varchar("git_author", { length: 255 }),
    canCreateRepos: boolean("can_create_repos").notNull().default(true),
    canReview: boolean("can_review").notNull().default(true),
    maxRepos: integer("max_repos").notNull().default(10),
    reviewStats: jsonb("review_stats"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("agents_owner_id_idx").on(table.ownerId)]
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    ownerId: uuid("owner_id").references(() => users.id),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id),
    createdBy: uuid("created_by"),
    gitPath: text("git_path").notNull(),
    description: text("description"),
    defaultBranch: varchar("default_branch", { length: 255 })
      .notNull()
      .default("main"),
    isPublic: boolean("is_public").notNull().default(false),
    mergePolicy: jsonb("merge_policy").notNull().default({
      min_approvals: 1,
      agent_approvals_sufficient: true,
      self_review_allowed: false,
      escalation_overrides_merge: true,
    }),
    reviewerConfig: jsonb("reviewer_config").notNull().default({
      reviewer_mode: "owner_agents",
      auto_assign: true,
    }),
    escalationPolicy: jsonb("escalation_policy").notNull().default({
      rules: [
        {
          trigger: "risk_level",
          value: "critical",
          action: "require_human",
        },
        {
          trigger: "reviewer_uncertainty",
          action: "surface_to_human",
        },
        {
          trigger: "conflict",
          action: "surface_to_human",
        },
      ],
    }),
    humanSummaryConfig: jsonb("human_summary_config").notNull().default({
      summary_triggers: ["escalation"],
      summary_on_all_changes: false,
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("repos_owner_id_idx").on(table.ownerId)]
);

export const changes = pgTable(
  "changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repositories.id),
    authorId: uuid("author_id").notNull(),
    authorType: actorTypeEnum("author_type").notNull(),
    branch: varchar("branch", { length: 255 }).notNull(),
    intent: text("intent"),
    riskLevel: riskLevelEnum("risk_level").notNull().default("medium"),
    scope: text("scope").array().notNull().default([]),
    decisions: jsonb("decisions").notNull().default([]),
    reviewFocus: jsonb("review_focus").notNull().default([]),
    reviewComments: jsonb("review_comments").notNull().default([]),
    refs: text("refs").array().notNull().default([]),
    commitCount: integer("commit_count").notNull().default(0),
    hasConflicts: boolean("has_conflicts").notNull().default(false),
    status: changeStatusEnum("status").notNull().default("pending_review"),
    escalated: boolean("escalated").notNull().default(false),
    escalationReason: text("escalation_reason"),
    humanSummaryId: uuid("human_summary_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("changes_repo_id_idx").on(table.repoId),
    index("changes_author_id_idx").on(table.authorId),
    index("changes_status_idx").on(table.status),
  ]
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    changeId: uuid("change_id")
      .notNull()
      .references(() => changes.id),
    reviewerId: uuid("reviewer_id").notNull(),
    reviewerType: actorTypeEnum("reviewer_type").notNull(),
    verdict: reviewVerdictEnum("verdict").notNull(),
    summary: text("summary"),
    decisions: jsonb("decisions"),
    uncertainty: text("uncertainty").array(),
    verifiedScope: text("verified_scope").array(),
    unverifiedScope: text("unverified_scope").array(),
    comments: jsonb("comments"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("reviews_change_id_idx").on(table.changeId),
    index("reviews_reviewer_id_idx").on(table.reviewerId),
  ]
);

export const permissionRules = pgTable(
  "permission_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repositories.id),
    agentId: uuid("agent_id").references(() => agents.id),
    ruleType: ruleTypeEnum("rule_type").notNull(),
    pattern: text("pattern").notNull(),
    conditions: jsonb("conditions"),
  },
  (table) => [index("perm_rules_repo_id_idx").on(table.repoId)]
);

export const humanSummaries = pgTable(
  "human_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    changeId: uuid("change_id")
      .notNull()
      .references(() => changes.id),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => agents.id),
    headline: text("headline").notNull(),
    whatHappened: text("what_happened").notNull(),
    whyCare: text("why_care").notNull(),
    keyDecisions: jsonb("key_decisions").notNull().default([]),
    uncertainty: text("uncertainty").notNull(),
    recommendation: summaryRecommendationEnum("recommendation").notNull(),
    confidence: summaryConfidenceEnum("confidence").notNull(),
    submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  },
  (table) => [index("human_summaries_change_id_idx").on(table.changeId)]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").references(() => repositories.id),
    actorId: uuid("actor_id").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    action: varchar("action", { length: 255 }).notNull(),
    metadata: jsonb("metadata"),
    timestamp: timestamp("timestamp").notNull().defaultNow(),
  },
  (table) => [
    index("audit_repo_id_idx").on(table.repoId),
    index("audit_actor_id_idx").on(table.actorId),
    index("audit_timestamp_idx").on(table.timestamp),
  ]
);

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Change = typeof changes.$inferSelect;
export type NewChange = typeof changes.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type PermissionRule = typeof permissionRules.$inferSelect;
export type NewPermissionRule = typeof permissionRules.$inferInsert;
export type HumanSummary = typeof humanSummaries.$inferSelect;
export type NewHumanSummary = typeof humanSummaries.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
