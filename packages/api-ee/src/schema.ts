import { pgTable, uuid, varchar, text, timestamp, boolean, integer, jsonb } from "drizzle-orm/pg-core";
import { agents, organizations, orgRole, repositories, users } from "@clawhub/api/schema";

// Org-level agent registry — curated agents per org with signing keys + trust tier.
export const orgAgentRegistry = pgTable("org_agent_registry", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  trustTier: varchar("trust_tier", { length: 20 }).notNull().default("sandbox"),
  approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
});

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

export type OrgInvite = typeof orgInvites.$inferSelect;
export type OrgTrial = typeof orgTrials.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type MarketplaceAgent = typeof marketplaceAgents.$inferSelect;
export type MarketplaceInstall = typeof marketplaceInstalls.$inferSelect;
export type CrmLead = typeof crmLeads.$inferSelect;
export type OrgAgentRegistry = typeof orgAgentRegistry.$inferSelect;
