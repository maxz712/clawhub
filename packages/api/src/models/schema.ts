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
  "pending",
  "approved",
  "rejected",
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
  "require_approval",
  "auto_merge",
]);

export const reviewerTypeEnum = pgEnum("reviewer_type", ["agent", "human"]);

export const changeSourceEnum = pgEnum("change_source", ["api", "git_push"]);

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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    type: agentTypeEnum("type").notNull().default("generic"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    publicKey: text("public_key"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("agents_owner_id_idx").on(table.ownerId),
  ]
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    gitPath: text("git_path").notNull(),
    description: text("description"),
    defaultBranch: varchar("default_branch", { length: 255 })
      .notNull()
      .default("main"),
    isPublic: boolean("is_public").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("repos_owner_id_idx").on(table.ownerId),
  ]
);

export const changes = pgTable(
  "changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repositories.id),
    agentId: uuid("agent_id").references(() => agents.id),
    intent: text("intent").notNull(),
    description: text("description"),
    status: changeStatusEnum("status").notNull().default("pending"),
    riskLevel: riskLevelEnum("risk_level").notNull().default("low"),
    branch: varchar("branch", { length: 255 }).notNull(),
    hasConflicts: boolean("has_conflicts").notNull().default(false),
    source: changeSourceEnum("source").notNull().default("api"),
    diffSummary: jsonb("diff_summary"),
    semanticDiff: jsonb("semantic_diff"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
  },
  (table) => [
    index("changes_repo_id_idx").on(table.repoId),
    index("changes_agent_id_idx").on(table.agentId),
    index("changes_status_idx").on(table.status),
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
  (table) => [
    index("perm_rules_repo_id_idx").on(table.repoId),
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").references(() => repositories.id),
    agentId: uuid("agent_id").references(() => agents.id),
    action: varchar("action", { length: 255 }).notNull(),
    metadata: jsonb("metadata"),
    timestamp: timestamp("timestamp").notNull().defaultNow(),
  },
  (table) => [
    index("audit_repo_id_idx").on(table.repoId),
    index("audit_agent_id_idx").on(table.agentId),
    index("audit_timestamp_idx").on(table.timestamp),
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
    reviewerType: reviewerTypeEnum("reviewer_type").notNull(),
    verdict: reviewVerdictEnum("verdict").notNull(),
    summary: text("summary"),
    comments: jsonb("comments"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("reviews_change_id_idx").on(table.changeId),
    index("reviews_reviewer_id_idx").on(table.reviewerId),
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
export type PermissionRule = typeof permissionRules.$inferSelect;
export type NewPermissionRule = typeof permissionRules.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
