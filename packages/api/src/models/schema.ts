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
export const changeStatus = pgEnum("change_status", ["draft", "pending", "approved", "changes_requested", "merged", "rolled_back", "abandoned"]);
export const riskLevel = pgEnum("risk_level", ["low", "medium", "high", "critical"]);
export const reviewVerdict = pgEnum("review_verdict", ["approve", "request_changes", "comment"]);
export const reviewerKind = pgEnum("reviewer_kind", ["agent", "human"]);
export const ciStatus = pgEnum("ci_status", ["pending", "running", "success", "failure", "skipped"]);
// "archived" (#42): closed + untouched 30 days, moved out of the closed list by the daily sweep. Enum values are append-only in Postgres.
export const issueStatus = pgEnum("issue_status", ["open", "closed", "archived"]);
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
  // Sealed at rest (libsodium) when CLAWHUB_SECRETS_KEY is set: totpSecret holds
  // the ciphertext and totpSecretNonce the nonce. A null nonce = legacy plaintext
  // (pre-sealing), accepted for backward compat. Widened to fit the ciphertext.
  totpSecret: varchar("totp_secret", { length: 255 }),
  totpSecretNonce: varchar("totp_secret_nonce", { length: 64 }),
  // Last consumed TOTP step counter — rejects replay of a code within its window.
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  // Session revocation: user JWTs carry this as the `v` claim; bumping it
  // invalidates every outstanding session (propagates within the token-cache
  // TTL). Tokens minted before the column existed count as v=0.
  tokenVersion: integer("token_version").notNull().default(0),
  // The Terms/Privacy version the user accepted (M3 legal). Recorded at register;
  // when the platform bumps CURRENT_TERMS_VERSION, /me flags re-acceptance. 0 =
  // pre-dates the versioned acceptance (accounts created before this shipped).
  termsVersion: integer("terms_version").notNull().default(0),
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
  // Soft-delete: a human removing one of their agents archives it (token
  // revoked, hidden from their list) rather than hard-deleting the row, so the
  // change/review history it authored stays intact. Nullable = live.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  // A ClawHub-owned SYSTEM agent (M4) — e.g. the native advisory reviewer. Not a
  // tenant's agent: hidden from rosters, its reviews are always advisory.
  isSystem: boolean("is_system").notNull().default(false),
  // v2 agents-ux: per-agent MODEL INTELLIGENCE — skills + MCP servers the
  // harness materializes for whichever CLI/API loop runs this agent:
  // { skills: [{name, content}], mcpServers: [{name, command?, args?, url?}] }.
  intelligence: jsonb("intelligence"),
  // v2 agents-ux: the ACCESS role constraining this agent (docs/agents-ux.md).
  // Null = legacy behavior (explicit grants only). Enforced at checkPushRights
  // + repoAccessFor: out-of-scope repo or missing permission = no access.
  accessRoleId: uuid("access_role_id"),
  // The human who created this agent. Agents are human-created (v2); kept
  // nullable for pre-v2 rows and self-host headless registration.
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // v3 identities: agents are first-class identities in the directory —
  // profile fields mirror users.avatarUrl/bio (docs/redesign-v3.md §1).
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  // v4: EVERY identity may belong to an org — including agents (an agent can
  // be the org's, not a person's). Default null = no org. Ops scoping and the
  // fleet views key on this; a person-owned agent keeps associatedUserId.
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
}, (t) => ({
  // `GET /agents` filters on associatedUserId; `POST /agents/personal` filters on
  // (associatedUserId, isPersonal). The composite covers both (leftmost prefix).
  byAssociatedUser: index("agents_assoc_user_idx").on(t.associatedUserId, t.isPersonal),
}));

// v2 agents-ux: BYO LLM keys are a user-owned VAULT — many agents can share
// one key. Sealed with CLAWHUB_SECRETS_KEY like every other secret; the API
// returns names/providers only, never plaintext.
export const llmKeys = pgTable("llm_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  provider: varchar("provider", { length: 40 }).notNull().default("anthropic"),
  ciphertext: text("ciphertext").notNull(),
  nonce: varchar("nonce", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOwner: index("llm_keys_owner_idx").on(t.ownerUserId),
}));

// v3 RBAC (docs/redesign-v3.md §2): an ACCESS role — a named PERMISSION SET +
// repo scope, assignable to ANY identity (human or agent) via role_assignments
// (agents also keep the legacy agents.accessRoleId pointer). Uniform merge
// rights: `change:merge` in a role grants merging at any risk, policy
// permitting — no kind carve-out.
export const accessRoles = pgTable("access_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Owner is a USER (personal roles) XOR an ORG (org-scoped roles managed by
  // org admins). ownerUserId went nullable in migration 0061 for the org case.
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  ownerOrgId: uuid("owner_org_id").references(() => organizations.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  // v3: a Permission[] array (services/permissions.ts). Legacy v2 rows hold
  // { push, review } objects — normalizePermissions() translates on read.
  permissions: jsonb("permissions").notNull().default([]),
  // WHERE it applies: "all" = every repo the owner governs; "selected" = repoIds.
  repoScope: varchar("repo_scope", { length: 16 }).notNull().default("all"),
  repoIds: jsonb("repo_ids").notNull().default([]),
  // Seeded defaults (Admin/Developer/Reviewer/Auditor) — editable but flagged.
  isBuiltin: boolean("is_builtin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOwner: index("access_roles_owner_idx").on(t.ownerUserId),
  byOrg: index("access_roles_org_idx").on(t.ownerOrgId),
}));

// v3 RBAC: role → identity assignments. Humans hold roles through this table;
// agents may too (their legacy agents.accessRoleId pointer remains a fallback).
// For AGENTS a role is a CEILING over their grants; for HUMANS it is an
// ADDITIVE grant (union with membership-derived access — a role can never
// lock an owner out of their own repo).
export const roleAssignments = pgTable("role_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleId: uuid("role_id").notNull().references(() => accessRoles.id, { onDelete: "cascade" }),
  identityKind: varchar("identity_kind", { length: 8 }).notNull(), // human | agent
  identityId: uuid("identity_id").notNull(),
  assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqAssignment: uniqueIndex("role_assignments_uniq").on(t.roleId, t.identityKind, t.identityId),
  byIdentity: index("role_assignments_identity_idx").on(t.identityKind, t.identityId),
}));

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull().unique(),
  displayName: varchar("display_name", { length: 200 }),
  // N3 · org-level provider allowlist: OpenRouter provider slugs (e.g. "deepinfra",
  // "fireworks") this org permits its platform-keyed runs to route to. NULL/empty =
  // every qualified catalog host. Enforced at the gateway (an org's compliance
  // posture can narrow, never widen, the catalog pin).
  llmProviderAllowlist: jsonb("llm_provider_allowlist"),
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
    // Empty on purpose: the non-removable BASELINE_SENSITIVE_GLOBS (merge-policy.ts)
    // already force human code review on these paths at evaluate time. Seeding
    // duplicate rows here just rendered a deletable-looking copy of rules that
    // cannot actually be deleted.
    pathOverrides: [],
    trustedAgents: [],
    allowedMergeMethods: ["merge", "squash", "rebase"],
    defaultMergeMethod: "merge",
  }),
  // Native advisory reviewer opt-out (M4). TRI-STATE: null = follow the platform
  // master flag (the default), true = force ON (the dogfood/force-on case, past
  // the BYO suppressor), false = opt OUT. The UI exposes it as a boolean toggle;
  // the null default keeps the gradual-rollout cohorts under platform control.
  nativeReviewerEnabled: boolean("native_reviewer_enabled"),
  // Platform-keyed VERIFY opt-in (D10). Verify is a metered $2 e2e run, so unlike the
  // advisory reviewer it is OFF unless a repo (or its Loop) turns it on. true = run the
  // platform verifier on every published Change (credit-gated); null/false = off.
  platformVerifyEnabled: boolean("platform_verify_enabled"),
  // v3 P6 — Graphify: the STRUCTURAL code index (symbols + references, not
  // memory) built incrementally on default-branch pushes. Default ON; a repo
  // opts out with false. Distinct from the memory graph (memory_edges).
  graphifyEnabled: boolean("graphify_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqName: uniqueIndex("repos_ns_name_uniq").on(t.namespaceType, t.namespaceId, t.name),
  byStars: index("repos_stars_idx").on(t.starsCount),
}));

export const repoCollaborators = pgTable("repo_collaborators", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  // Exactly ONE of agentId / userId is set: an agent grant (the original kind)
  // or a HUMAN grant (give one person access to ONE repo without org-wide
  // membership). NULLs are distinct in Postgres, so the two unique indexes below
  // don't collide across the two kinds.
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  role: collaboratorRole("role").notNull().default("writer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqCollab: uniqueIndex("repo_collab_uniq").on(t.repoId, t.agentId),
  uniqHumanCollab: uniqueIndex("repo_collab_human_uniq").on(t.repoId, t.userId),
}));

// Org-level default merge policy: applied to NEW org repos at creation (the
// system default otherwise). A per-repo policy + an in-repo .clawhub/policies/
// merge.yml still override after creation. One row per org.
export const orgMergePolicy = pgTable("org_merge_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }),
  policy: jsonb("policy").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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

// Source-import jobs. An import (clone + issues) can take a while for a large
// repo, so the migrate routes run it in the background and return a job id; this
// row is the pollable status. `result` holds the ImportResult once it succeeds.
export const importJobs = pgTable("import_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 16 }).notNull(),   // github | gitlab | bitbucket
  source: text("source").notNull(),                          // e.g. "owner/repo" (display)
  targetNamespace: text("target_namespace"),
  status: varchar("status", { length: 12 }).notNull().default("pending"), // pending|running|success|failure
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "set null" }),
  result: jsonb("result"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byAgent: index("import_jobs_agent_idx").on(t.agentId, t.createdAt),
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
  // The e2e verification TIER the server selected for this Change (services/verify-tier.ts):
  // static|app|services|dind. Computed at post-push from the diff + repo policy + the head
  // .clawhub/verify.yml — the SINGLE server-derived source of truth, read by the verify
  // dispatch (privileged ONLY for dind), the harness (which tier it boots), and the
  // attestation (which stamps the tier from HERE, never the agent's claim). Nullable
  // until the first post-push pass. Demotes the heavy DinD boot to an opt-in last resort.
  verifyTier: varchar("verify_tier", { length: 12 }),
  verifyTierReason: text("verify_tier_reason"),
  // `scope` is what the agent DECLARED (the Scope: trailer, drives review
  // focus). `changedPaths` is what git actually changed (authoritative). The
  // merge gate's sensitive-path forcing reads changedPaths so an agent can't
  // dodge a code-review requirement by under-reporting its Scope: trailer.
  scope: jsonb("scope").notNull().default([]),
  changedPaths: jsonb("changed_paths").notNull().default([]),
  reviewFocus: jsonb("review_focus").notNull().default([]),
  // Deterministic focus floor (M1). Synthesized from the diff at post-push
  // (services/focus-synthesis.ts) — ranked files, sensitive-path derived focus,
  // rollback/co-change callouts. Kept PARALLEL to reviewFocus (the author's own
  // flags stay auditable); nullable until the first post-push pass. See
  // docs/review-overhaul-plan.md M1.
  reviewBrief: jsonb("review_brief"),
  // The Change's prose description: the commit bodies with the trailer block
  // stripped, captured at push (8KB cap). Distinct from `intent` (the one-line
  // Intent: trailer). Nullable — many commits carry only a subject.
  description: text("description"),
  trailers: jsonb("trailers").notNull().default({}),
  status: changeStatus("status").notNull().default("pending"),
  hasConflicts: boolean("has_conflicts").notNull().default(false),
  escalated: boolean("escalated").notNull().default(false),
  escalationReason: text("escalation_reason"),
  // Authoring identity. A Change is opened by EXACTLY ONE of an agent or a human
  // user. `openedByAgentId` is set for agent pushes (the historical, still-common
  // case); `openedByUserId` is set when a human pushes their own code with a user
  // token. Both are nullable FKs; post-push enforces the one-of invariant. Humans
  // became first-class pushers in 0026 — before that every Change had an agent.
  openedByAgentId: uuid("opened_by_agent_id").references(() => agents.id, { onDelete: "restrict" }),
  openedByUserId: uuid("opened_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  // v3 wrappers (docs/redesign-v3.md §3): for an AGENT push, the sponsoring
  // human — the agent's associated (claimed/personal) or creating user at push
  // time. The git author-vs-committer pattern: acting identity + sponsor.
  // Null for human pushes and for headless agents with no governing human.
  onBehalfOfUserId: uuid("on_behalf_of_user_id").references(() => users.id, { onDelete: "set null" }),
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
  // ADVISORY reviews (M4) inform but never gate: the native platform reviewer's
  // verdict is stamped advisory=true and filtered out at every approval-counting
  // site (a machine opinion can't satisfy the human/verified merge gate). `contract`
  // holds the validated native-review-v1 payload (verdict + intent_vs_diff summary).
  advisory: boolean("advisory").notNull().default(false),
  contract: jsonb("contract"),
  // v3 P5 (focused review): whether the reviewer expanded the FULL diff before
  // submitting. Auto-collapse hides unflagged files by default — recording the
  // expansion keeps a basis:"code" approval honest about what was read.
  viewedFullDiff: boolean("viewed_full_diff").notNull().default(false),
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
  // Per-run activation payload for a MANUAL standing-agent tick: an operator can point an idle
  // agent at an ad-hoc task and/or a specific issue at trigger time (not baked into the agent).
  // standingRunEnv surfaces these as CLAWHUB_TASK / CLAWHUB_ISSUE, overriding the agent's stored
  // task, so an idle `develop` agent activates from a prompt, an issue, or both. Null otherwise.
  dispatchTask: text("dispatch_task"),
  dispatchIssue: integer("dispatch_issue"),
  // Concurrency control: runs sharing a non-null group serialize — at most one
  // runs at a time (enforced by the partial unique index below); the rest wait
  // as `pending` and are dispatched newest-first when the group frees. Set e.g.
  // to `merge:<repoId>` on merge→deploy runs so deploys never race on the one
  // shared production checkout.
  concurrencyGroup: varchar("concurrency_group", { length: 200 }),
  // sha256 of the per-run LLM-gateway token (M3 custody). A platform-keyed run
  // gets a gateway token as its "API key" + ANTHROPIC_BASE_URL → the gateway; the
  // container never sees the real platform key. The gateway resolves an incoming
  // token by sha256 → the RUNNING run here, so the token dies when the run goes
  // terminal (metering is authoritative from day one; exfil closed by construction).
  gatewayTokenHash: varchar("gateway_token_hash", { length: 64 }),
  // Per-run model override (M4). The native reviewer's model is SELECTED per-change
  // (deterministic risk router: Haiku vs Sonnet), not baked on the agent row — so
  // the choice is stamped here and surfaced as CLAWHUB_MODEL. Null → the agent's default.
  dispatchModel: varchar("dispatch_model", { length: 64 }),
  // v3 P4: the human who ASKED for this run (thread slash command, Run-now
  // click). Distinct from the acting agent — pure attribution for the
  // Workflow Runs audit surface. SET NULL so runs survive account deletion.
  triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // v4: the WORKFLOW that dispatched this run (null for CI runs, legacy
  // standing ticks, and system reviewer/verifier runs). A workflow's activity
  // history is exactly `ci_runs WHERE workflow_id = :id`.
  workflowId: uuid("workflow_id").references((): AnyPgColumn => workflows.id, { onDelete: "set null" }),
  logUrl: text("log_url"),
  stepResults: jsonb("step_results").notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // --- Unified async-job scheduler (docs/job-scheduler-design.md) ---
  // Static priority band (Borg-style): higher = dispatched first (deploy 600 >
  // on:push 500 > verify 400 > review 300 > develop 200 > scout 100). Stamped at
  // enqueue from origin (CI) / agent mode. Null = legacy/unclassified → the
  // scheduler treats it as the lowest band.
  priorityClass: integer("priority_class"),
  // Persisted resource REQUEST {cpus, memoryMb, timeoutSec, tier}. Today these ride
  // only in the transient ci.run.queued payload and are LOST on re-dispatch; the
  // scheduler needs them persisted to bin-pack across nodes + to rebuild the payload
  // on retry/re-dispatch.
  resourceRequest: jsonb("resource_request"),
  // Arch pin ('amd64'|'arm64'|null=any), persisted so it survives re-dispatch (today
  // it lives only in the pipeline triggerConfig / the payload).
  runsOn: varchar("runs_on", { length: 16 }),
  // Scheduler placement: the node this run is assigned to. Null = unplaced (a runner
  // may still claim it under the fallback broadcast race when the scheduler is off).
  assignedNode: varchar("assigned_node", { length: 64 }),
  // Last-computed effective priority (band + aging). Drives the runner's claim
  // ORDER BY + observability; recomputed each scheduler pass. Aging clock = createdAt.
  effectivePriority: integer("effective_priority"),
  // --- Staleness / retry / stuck detection (built into the job abstraction) ---
  // Retry accounting. attempts starts at 0; a TRANSIENT-failure retry re-enqueues a
  // fresh run with attempts+1. A genuine test failure does NOT retry — retry is keyed
  // on terminalReason, not a blanket count. See services/run-staleness.ts.
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(1),
  // Why the run reached terminal: success|failed|stale|superseded|stuck|preempted|
  // canceled. Drives retry-vs-stop: superseded/stale/canceled never retry;
  // stuck/infra may retry up to maxAttempts.
  terminalReason: varchar("terminal_reason", { length: 24 }),
  // Runner progress heartbeat. The runner POSTs this periodically while a container
  // is alive; the reaper treats a running run whose heartbeat has gone stale as STUCK
  // even before its wall-clock timeout (a hung process makes no progress).
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
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
  // (#80) Widened to (agent, repo): per-agent alone made a v4 repo-less fan-out
  // 23505 on its second repo's pending insert, collapsing "all repos" workflows
  // to one repo per tick. Per (agent, repo) keeps the double-dispatch guard
  // exactly as strong for any single repo. Migration 0067.
  uniqStandingPending: uniqueIndex("ci_runs_standing_pending_uniq")
    .on(t.standingAgentId, t.repoId)
    .where(sql`status = 'pending' and standing_agent_id is not null`),
  // Concurrency control: AT MOST ONE running run per concurrency group. The claim
  // that would flip a second run in a group to `running` violates this and fails
  // with 23505 — the API treats that as "group busy", leaves the run pending, and
  // re-dispatches it when the group frees. Atomic at the DB (a NOT EXISTS guard
  // would race under READ COMMITTED). Backs serialized merge→deploy runs.
  uniqRunningPerGroup: uniqueIndex("ci_runs_running_group_uniq")
    .on(t.concurrencyGroup)
    .where(sql`status = 'running' and concurrency_group is not null`),
}));

// A standing agent: a BYO container image that ClawHub runs continuously, on a
// schedule, or on events, scoped to one repo, acting as `agentId`. ClawHub never
// runs the model — the container does, with the sealed LLM key injected at run
// time. See docs/standing-agents.md. Ticks dispatch as ci_runs(origin='agent').
export const standingAgents = pgTable("standing_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  // v4 (docs/redesign-v4.md): a DEPLOYMENT is repo-LESS by default — repoId
  // NULL means "works across every repo the agent's role scope + its owner's
  // governance admit"; the repo a run targets is resolved at dispatch time
  // (from the workflow's scope, or the thread a slash command was typed in).
  // Non-null repoId = legacy per-repo rows + the system reviewer/verifier
  // (which stay repo-pinned by design).
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
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
  // Which coding-agent CLI the harness shells out to: claude | copilot | codex |
  // gemini (→ CLAWHUB_CLI). Orthogonal to llmProvider (the credential/backend):
  // the container gets CLAWHUB_CLI + the CLI's matching *_API_KEY. Legacy rows →
  // "claude" (the historical hardcoded CLI). See standingLlmEnv.
  cli: varchar("cli", { length: 16 }).notNull().default("claude"),
  // v3 BYO execution style: "cli" (harness shells out to the coding-agent CLI,
  // the default) or "api" (harness-driven direct API loop against the key's
  // provider). Threaded to the container as CLAWHUB_EXEC_STYLE; the harness
  // api-loop driver ships in the next harness image batch.
  execStyle: varchar("exec_style", { length: 8 }).notNull().default("cli"),
  // Optional model override → injected as CLAWHUB_MODEL and passed to the CLI's
  // --model flag (e.g. "sonnet" pins claude to Sonnet). null = the CLI's default.
  model: varchar("model", { length: 64 }),
  // Where the LLM key comes from (M3 custody): "byo" (the sealed key on this row,
  // the default + only option for user-authored agents) or "platform" (the
  // platform key, NEVER injected into the container — the run gets a per-run
  // gateway token and ANTHROPIC_BASE_URL pointing at the metering gateway). Only
  // ClawHub-owned system agents may be "platform"; enforced at dispatch. See D2.
  keySource: varchar("key_source", { length: 16 }).notNull().default("byo"),
  // A ClawHub-owned system standing agent (M4) — the native advisory reviewer,
  // lazily provisioned per repo. Hidden from tenant standing-agent listings + the
  // BYO-suppressor never counts it as the repo's reviewer.
  isSystem: boolean("is_system").notNull().default(false),
  llmBaseUrl: text("llm_base_url"),
  // Sealed (libsodium) LLM API key + agent push token. NEVER returned by any API;
  // delivered to the claiming runner only via the per-run-token secrets endpoint.
  llmCiphertext: text("llm_ciphertext"),
  llmNonce: varchar("llm_nonce", { length: 120 }),
  // v2 agents-ux: which VAULT key (llm_keys) this deployment's sealed copy came
  // from — display/rotation bookkeeping; the sealed copy above stays the
  // dispatch source so a vault delete can't brick a running deployment.
  llmKeyId: uuid("llm_key_id").references(() => llmKeys.id, { onDelete: "set null" }),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenNonce: varchar("token_nonce", { length: 120 }).notNull(),
  memoryMb: integer("memory_mb").notNull().default(1024),
  cpus: integer("cpus").notNull().default(1),
  timeoutSec: integer("timeout_sec").notNull().default(1800),
  // Network containment for the BYO container. The container can open a browser
  // and reach the network (LLM + push + UI testing); this bounds WHERE it may go.
  //   none      → infra only (ClawHub API/git + the LLM endpoint). The agent can
  //               still get its issue + push, and the browser can hit the app it
  //               starts on localhost, but it reaches nothing else on the internet.
  //   allowlist → infra + egressAllowedHosts (host patterns).
  //   all       → any PUBLIC host (private/metadata ranges stay blocked always).
  // Enforced by a per-run allowlisting egress proxy in the runner. Whatever the
  // agent does on the network physically stays in its sandbox. See egress-proxy.cjs.
  egressPolicy: varchar("egress_policy", { length: 16 }).notNull().default("none"),
  egressAllowedHosts: jsonb("egress_allowed_hosts").$type<string[]>().notNull().default([]),
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
  // v4: at most ONE global (repo-less) deployment per agent identity.
  uniqGlobalPerAgent: uniqueIndex("standing_agents_global_agent_uniq").on(t.agentId).where(sql`repo_id IS NULL`),
  byRepo: index("standing_agents_repo_idx").on(t.repoId),
  byTrigger: index("standing_agents_trigger_idx").on(t.trigger),
  byRole: index("standing_agents_role_idx").on(t.roleId),
}));

// v4 WORKFLOWS (docs/redesign-v4.md): a workflow is WHERE users tell an agent
// what to do — instructions (slash flags or natural language) + its OWN
// schedule/trigger + an optional repo scope (default: all repos the
// deployment reaches). Deployments (standing_agents) carry identity/role/
// provider only; cadence and instructions live HERE. Editable; each run
// stamps ci_runs.workflow_id so a workflow has its own activity history.
export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  standingAgentId: uuid("standing_agent_id").notNull().references(() => standingAgents.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  // Slash-flag or natural-language instructions, expanded at dispatch
  // (services/agent-workflows.ts) exactly like every other run task.
  instructions: text("instructions").notNull().default(""),
  // manual | schedule | event | continuous
  trigger: varchar("trigger", { length: 16 }).notNull().default("manual"),
  cron: varchar("cron", { length: 120 }),
  event: varchar("event", { length: 64 }),
  intervalSec: integer("interval_sec").notNull().default(3600),
  // WHERE it runs: "all" = every repo the deployment reaches; "selected" = repoIds.
  repoScope: varchar("repo_scope", { length: 16 }).notNull().default("all"),
  repoIds: jsonb("repo_ids").notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  // Compare-and-swap marker for the schedule tick (mirrors ciPipelines).
  lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byDeployment: index("workflows_deployment_idx").on(t.standingAgentId),
  byTrigger: index("workflows_trigger_idx").on(t.trigger),
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
  // Coding-agent CLI the deployed harness runs: claude | copilot | codex | gemini
  // (→ CLAWHUB_CLI). Propagated to each standing_agent this role deploys.
  cli: varchar("cli", { length: 16 }).notNull().default("claude"),
  // Optional model override propagated to each standing_agent this role deploys
  // (→ CLAWHUB_MODEL → the CLI's --model, e.g. sonnet/opus). Null → the CLI's default.
  model: varchar("model", { length: 64 }),
  // "byo" | "platform" — propagated to each standing_agent this role deploys (M3
  // custody). The native-reviewer system role is born "platform"; user roles byo.
  keySource: varchar("key_source", { length: 16 }).notNull().default("byo"),
  llmBaseUrl: text("llm_base_url"),
  // The role's dedicated agent + sealed creds (the LLM key + the agent push token).
  // Deployments re-seal these per standing_agent. NEVER returned by any API.
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  llmCiphertext: text("llm_ciphertext"),
  llmNonce: varchar("llm_nonce", { length: 120 }),
  // v2 agents-ux: which VAULT key (llm_keys) this deployment's sealed copy came
  // from — display/rotation bookkeeping; the sealed copy above stays the
  // dispatch source so a vault delete can't brick a running deployment.
  llmKeyId: uuid("llm_key_id").references(() => llmKeys.id, { onDelete: "set null" }),
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

// A verification run: ClawHub's server-trusted record that a deployed verify-mode
// reviewer agent ran a Change end-to-end (API/UI/CLI checks) against an EXACT head
// commit, and what it observed. This is the non-spoofable anchor for verified
// autonomy (merge-policy.ts): evaluateMerge trusts a verifiedAttestation only when
// a `success` row exists for the Change's CURRENT head. A new push changes the
// head → the prior row no longer matches → the attestation is stale and ignored.
// The agent can't forge it: ClawHub mints the underlying ci_runs row
// (origin='agent') and the report endpoint binds the caller's agent identity +
// the run's commit (from ClawHub's DB, not the payload). See services/verification.ts.
export const verificationRuns = pgTable("verification_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  changeId: uuid("change_id").notNull().references(() => changes.id, { onDelete: "cascade" }),
  // The ClawHub-owned run this report came from (origin='agent') — the trust anchor.
  ciRunId: uuid("ci_run_id").references(() => ciRuns.id, { onDelete: "set null" }),
  // The deployed verify-mode reviewer that produced it + its agent identity
  // (denormalized for the independence check: verifier must differ from author).
  standingAgentId: uuid("standing_agent_id").references(() => standingAgents.id, { onDelete: "set null" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  // The commit this attests. Matched against the Change's live head at evaluate
  // time — any mismatch (a new push) makes the attestation stale.
  headCommit: varchar("head_commit", { length: 64 }).notNull(),
  // Server-computed from `checks`: success only when failedCount===0 && passedCount>0.
  status: varchar("status", { length: 12 }).notNull().default("pending"),
  // The tier this attestation was produced AT, stamped from the Change's server-derived
  // verifyTier (NOT the agent's claim). The gate's tier-vs-coverage guard uses it: a
  // `ui` claim at `static` (no browser ran) is rejected; the gate's minTier band rejects
  // an attestation too weak for the Change's effective risk. See services/verification.ts.
  tier: varchar("tier", { length: 12 }),
  // The check KINDS the server could corroborate with observed evidence (a `ui` claim
  // backed by an uploaded head-pinned screenshot, an `api` claim by an egress-proxy log).
  // Accepted coverage = intersection(claimed, observed); absence → inconclusive → human.
  observedCoverage: jsonb("observed_coverage").notNull().default([]),
  // [{kind:'api'|'ui'|'cli'|'script', name, expected?, observed?, ok, command?, exitCode?, evidenceUrl?}]
  checks: jsonb("checks").notNull().default([]),
  // Conformance verify (M5): the behavior-spec BASIS this attestation verified
  // against — issue | description | inferred — resolved SERVER-SIDE at record time
  // (services/spec-resolver.ts), never the payload. The merge gate reads it: an
  // inferred-basis attestation satisfies verified autonomy only up to
  // `maxInferredSpecRisk`. Null/legacy = treated as inferred (conservative).
  specBasis: varchar("spec_basis", { length: 16 }),
  specExcerpt: text("spec_excerpt"), // 2KB audit trail of the spec it checked
  // Description↔diff divergence the verifier found — undeclared behavior is the
  // signature of a sneaky change. [{path?, description}]. Surfaced as an amber
  // "undeclared scope" banner; does NOT by itself fail the attestation.
  divergence: jsonb("divergence").notNull().default({ undeclared: [] }),
  passedCount: integer("passed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  // One attestation per (change, head): re-verifying the same head replaces it.
  uniqChangeHead: uniqueIndex("verification_runs_change_head_uniq").on(t.changeId, t.headCommit),
  byChange: index("verification_runs_change_idx").on(t.changeId),
}));

// Plan-then-playback cheap verify (M6). A verify run authors a PLAN (a scripted
// browse sequence + a steps→checks map); a later verify run on the SAME change
// with unchanged paths/spec/tier REPLAYS the plan with ZERO model tokens and
// attests from the deterministic result. Steps are server-validated (whitelist +
// goto restricted to relative/localhost) so a plan can't be a scripted attack.
export const verifyPlans = pgTable("verify_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  changeId: uuid("change_id").notNull().references(() => changes.id, { onDelete: "cascade" }),
  // The verify run + agent that AUTHORED the plan (re-bound like recordVerification).
  standingAgentId: uuid("standing_agent_id").references(() => standingAgents.id, { onDelete: "set null" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  // The validated browse steps + the steps→checks map (derive checks from the
  // playback's browse-result.json × checkMap).
  steps: jsonb("steps").notNull().default([]),
  checkMap: jsonb("check_map").notNull().default({}),
  // Staleness anchors: a plan is invalid the moment the diff paths, the resolved
  // spec, or the verify tier change under it — playback then falls through to a
  // full model verify. Plus a 2-consecutive-failure counter.
  changedPathsHash: varchar("changed_paths_hash", { length: 64 }).notNull(),
  specHash: varchar("spec_hash", { length: 64 }).notNull(),
  tier: varchar("tier", { length: 12 }),
  failureCount: integer("failure_count").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  // At most one ACTIVE plan per change.
  uniqActive: uniqueIndex("verify_plans_active_uniq").on(t.changeId).where(sql`active = true`),
  byChange: index("verify_plans_change_idx").on(t.changeId),
}));
export type VerifyPlan = typeof verifyPlans.$inferSelect;

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
  // Devin-style approval gate for AGENT-authored SHARED-scope (repo/org) writes:
  // set at write, cleared by a human approve (PATCH action) — a pending row is
  // invisible to retrieval/packs, so one agent can't seed every collaborator's
  // context without a human ever seeing the note. Own-scope (agent/agent_repo)
  // writes and server-side mechanical captures are never pending.
  pendingAt: timestamp("pending_at", { withTimezone: true }),
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

// Memory graph — typed, weighted, soft-deletable edges OVER agent_memories, so a
// standing agent's notes stop being flat lexical islands. TWO destinations,
// discriminated by `dstKind`: a memory→memory relation
// (relates_to/refines/caused_by/contradicts/duplicate_of/depends_on) or a
// memory→code-entity link (`about`, keyed by the repo-relative path the code index
// already uses). SAME invariant split as the notes: the AGENT authors cognitive
// edges (origin='agent'); ClawHub DERIVES mechanical ones (origin='derived':
// co-errorFingerprint, high path-overlap, facts.paths→about) with ZERO inference.
// Graph-walk retrieval then surfaces memories CONNECTED to the diff, not only the
// ones that lexically match it. Auth is enforced on the memory rows an edge
// connects (they carry scopeKey), so edges only ever surface memories the reader
// can already see. See docs/memory.md.
export const memoryEdgeRelation = pgEnum("memory_edge_relation", [
  "relates_to", "refines", "caused_by", "contradicts", "duplicate_of", "depends_on", "about",
]);

export const memoryEdges = pgTable("memory_edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Tenant boundary — the src memory's repo (for the code-seed index + cascade).
  // Nullable for edges between agent-scoped (repo-less) memories.
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
  // Source is ALWAYS a memory.
  srcMemoryId: uuid("src_memory_id").notNull().references(() => agentMemories.id, { onDelete: "cascade" }),
  // Destination: a memory (dstKind='memory') OR a code-entity path (dstKind='code').
  dstKind: varchar("dst_kind", { length: 8 }).notNull(),        // 'memory' | 'code'
  dstMemoryId: uuid("dst_memory_id").references(() => agentMemories.id, { onDelete: "cascade" }),
  dstPath: text("dst_path"),                                    // repo-relative path when dstKind='code'
  relation: memoryEdgeRelation("relation").notNull(),
  weight: integer("weight").notNull().default(50),             // 0..100 edge strength/confidence
  // Provenance + governance (parity with agent_memories).
  origin: varchar("origin", { length: 8 }).notNull().default("agent"),  // 'agent' | 'derived'
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  sourceRunId: uuid("source_run_id").references(() => ciRuns.id, { onDelete: "set null" }),
  validTo: timestamp("valid_to", { withTimezone: true }),      // soft-delete; null = live
  quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  bySrc: index("memory_edges_src_idx").on(t.srcMemoryId).where(sql`valid_to is null and quarantined_at is null`),
  byDst: index("memory_edges_dst_idx").on(t.dstMemoryId).where(sql`valid_to is null and quarantined_at is null`),
  byCode: index("memory_edges_code_idx").on(t.repoId, t.dstPath).where(sql`dst_kind = 'code' and valid_to is null and quarantined_at is null`),
  byAuthor: index("memory_edges_author_idx").on(t.createdByAgentId),
  // Dedupe: one live edge per (src, relation, dst) — memory + code variants split
  // so a null dstMemoryId (code edge) doesn't collide across the code corpus.
  uniqMem: uniqueIndex("memory_edges_uniq_mem").on(t.srcMemoryId, t.relation, t.dstMemoryId).where(sql`dst_kind = 'memory'`),
  uniqCode: uniqueIndex("memory_edges_uniq_code").on(t.srcMemoryId, t.relation, t.dstPath).where(sql`dst_kind = 'code'`),
}));
export type MemoryEdge = typeof memoryEdges.$inferSelect;

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
  // Denormalized handle so audit rows stay readable after a GDPR scrub
  // clears actorId (the platform_usage precedent). Cleared on delete too.
  actorHandle: varchar("actor_handle", { length: 120 }),
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
  emailOnChangeRolledBack: boolean("email_on_change_rolled_back").notNull().default(true),
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
  // Actor: an agent OR a human user (one of the two). `userId` is set when a
  // human authored the activity (e.g. a human-pushed Change); `agentId` for agent
  // activity. Both nullable so feed rows survive actor deletion.
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
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

// Authoritative platform-LLM metering (M3). One row per gateway request the
// platform key served — the billing source of truth, distinct from the
// SELF-REPORTED cost_ledger. Attribution is DENORMALIZED (run/change/repo/org/
// user copied at write time) and every FK is SET NULL: a billing row must
// survive repo/change deletion (do NOT copy cost_ledger's cascade). Meter at
// message_start (input), finalize at message_delta (output). See docs + D1/D6.
export const platformUsage = pgTable("platform_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").references(() => ciRuns.id, { onDelete: "set null" }),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "set null" }),
  repoId: uuid("repo_id").references(() => repositories.id, { onDelete: "set null" }),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  model: varchar("model", { length: 120 }).notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costMicroUsd: integer("cost_micro_usd").notNull().default(0),
  // The metered SKU (review_overage | verify_run | …) — set by the biller (M7);
  // null until a SKU is stamped. `playback:true` in `meta` marks a zero-token
  // playback verify (metering discriminator, M6).
  billedSku: varchar("billed_sku", { length: 40 }),
  meta: jsonb("meta").notNull().default({}),
  // When the usage was reported to Stripe (M7). Null = unbilled; the 5-min
  // reporter scans a partial index on this.
  stripeReportedAt: timestamp("stripe_reported_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRepo: index("platform_usage_repo_idx").on(t.repoId, t.createdAt),
  byOrg: index("platform_usage_org_idx").on(t.orgId, t.createdAt),
  byUser: index("platform_usage_user_idx").on(t.userId, t.createdAt),
  // The billing reporter (M7) scans unbilled rows — a partial index keeps it O(unbilled).
  unbilled: index("platform_usage_unbilled_idx").on(t.createdAt).where(sql`${t.stripeReportedAt} is null`),
}));
export type PlatformUsage = typeof platformUsage.$inferSelect;

// Per-tenant platform-spend budget (M7 billing). Separate from cost_budgets (which
// caps SELF-REPORTED BYO spend) — this caps the AUTHORITATIVE platform-key spend.
// Org XOR user. On exhaust: fall back to the tenant's BYO key, queue to next
// tick, or hard-block. Alert at a % threshold.
export const platformBudgets = pgTable("platform_budgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  monthlyCapMicroUsd: bigint("monthly_cap_micro_usd", { mode: "number" }).notNull().default(0),
  onExhaust: varchar("on_exhaust", { length: 16 }).notNull().default("byo_fallback"), // byo_fallback | queue | block
  alertAtPercent: integer("alert_at_percent").notNull().default(80),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byOrg: index("platform_budgets_org_idx").on(t.orgId),
  byUser: index("platform_budgets_user_idx").on(t.userId),
}));
export type PlatformBudget = typeof platformBudgets.$inferSelect;

// Org-connected LLM keys (N3, the D2 fallback): an org pastes its OWN provider key
// once; the metering gateway then forwards THAT org's platform-keyed runs with the
// org's key (sealed at rest, never in a container) instead of ClawHub's platform
// key — the org pays its provider directly, ClawHub still meters for visibility +
// governance but does NOT bill the platform SKU (usage marked keyOwner='org'). One
// key per (org, provider). baseUrl overrides the provider default when set.
export const orgLlmKeys = pgTable("org_llm_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 24 }).notNull(), // anthropic | openai (openrouter-compatible)
  keyCiphertext: text("key_ciphertext").notNull(),
  keyNonce: text("key_nonce").notNull(),
  baseUrl: text("base_url"), // optional upstream override (e.g. an OpenRouter/self-host URL)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byOrgProvider: uniqueIndex("org_llm_keys_org_provider_uniq").on(t.orgId, t.provider),
}));
export type OrgLlmKey = typeof orgLlmKeys.$inferSelect;

// The autonomous Loop (M8): a one-click bundle of a developer + a verified-
// reviewer (+ optional triager) on a repo, with a policy DIAL. `appliedPolicySha`
// is the hash of the merge policy the install wrote — uninstall only reverts if
// the current policy still matches it, so a human's later edits aren't clobbered.
export const repoLoops = pgTable("repo_loops", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }).unique(),
  autonomy: varchar("autonomy", { length: 16 }).notNull().default("review_only"), // review_only | low | medium
  developerRoleId: uuid("developer_role_id").references((): AnyPgColumn => agentRoles.id, { onDelete: "set null" }),
  reviewerRoleId: uuid("reviewer_role_id").references((): AnyPgColumn => agentRoles.id, { onDelete: "set null" }),
  triagerRoleId: uuid("triager_role_id").references((): AnyPgColumn => agentRoles.id, { onDelete: "set null" }),
  // The issue-scout (front of the Loop): files issues on the work cadence. Optional
  // like the triager; null when the Loop was installed without a scout.
  scoutRoleId: uuid("scout_role_id").references((): AnyPgColumn => agentRoles.id, { onDelete: "set null" }),
  appliedPolicySha: varchar("applied_policy_sha", { length: 64 }),
  status: varchar("status", { length: 16 }).notNull().default("active"), // active | killed
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type RepoLoop = typeof repoLoops.$inferSelect;

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

// v3 P6 — Graphify: the mechanical CODE GRAPH (docs/redesign-v3.md §6). Nodes
// are symbol definitions (function/class/type/const/route) per path; edges are
// imports/references between paths. Built incrementally on default-branch
// pushes in the code-index path — no LLM, no agent. NOT the memory graph.
export const codeGraphNodes = pgTable("code_graph_nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  symbol: varchar("symbol", { length: 200 }).notNull(),
  kind: varchar("kind", { length: 16 }).notNull(), // function | class | type | const | route
  line: integer("line").notNull().default(1),
  commitSha: varchar("commit_sha", { length: 64 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRepoPath: index("code_graph_nodes_repo_path_idx").on(t.repoId, t.path),
  byRepoSymbol: index("code_graph_nodes_repo_symbol_idx").on(t.repoId, t.symbol),
}));

export const codeGraphEdges = pgTable("code_graph_edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  srcPath: text("src_path").notNull(),
  dstPath: text("dst_path").notNull(),
  kind: varchar("kind", { length: 16 }).notNull().default("imports"), // imports | references
  line: integer("line").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRepoSrc: index("code_graph_edges_repo_src_idx").on(t.repoId, t.srcPath),
  byRepoDst: index("code_graph_edges_repo_dst_idx").on(t.repoId, t.dstPath),
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
}, t => ({
  // AT MOST ONE subscription row per tenant — the webhook + checkout upserts key
  // on these so a redelivered/duplicate event can't mint a second row (and a
  // second Stripe customer). Partial because org/user are mutually-exclusive nulls.
  uniqOrg: uniqueIndex("subscriptions_org_uniq").on(t.orgId).where(sql`org_id is not null`),
  uniqUser: uniqueIndex("subscriptions_user_uniq").on(t.userId).where(sql`user_id is not null`),
}));

// Stripe webhook idempotency (money safety). Stripe redelivers events on any
// non-2xx/timeout; we record each event.id and short-circuit a redelivery so its
// side effects (subscription upserts) never replay.
export const stripeEvents = pgTable("stripe_events", {
  eventId: varchar("event_id", { length: 80 }).primaryKey(),
  type: varchar("type", { length: 80 }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
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

// GitHub App (N2): mirror-and-verify. A pull_request on an installed GitHub repo
// is mirrored into a private shadow ClawHub repo (owned by the `gh-mirror`
// service user), the normal review/verify stack runs on it, and the result is
// posted back to GitHub as an advisory check-run + a PR comment with signed
// evidence links. Custody parallel to the LLM gateway: the App private key is
// read ONLY in the API process and never enters a container.
export const githubInstallations = pgTable("github_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  installationId: varchar("installation_id", { length: 32 }).notNull().unique(), // GitHub numeric id (stored as text)
  accountLogin: varchar("account_login", { length: 120 }).notNull(),
  accountType: varchar("account_type", { length: 24 }).notNull().default("User"), // User | Organization
  accountId: varchar("account_id", { length: 32 }),
  repoSelection: varchar("repo_selection", { length: 24 }).notNull().default("selected"), // all | selected
  // The ClawHub user who installed/owns this link (resolved via OAuth login match, best-effort).
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type GithubInstallation = typeof githubInstallations.$inferSelect;

export const githubPrMirrors = pgTable("github_pr_mirrors", {
  id: uuid("id").primaryKey().defaultRandom(),
  installationId: varchar("installation_id", { length: 32 }).notNull(),
  owner: varchar("owner", { length: 120 }).notNull(),
  repo: varchar("repo", { length: 120 }).notNull(),
  prNumber: integer("pr_number").notNull(),
  headSha: varchar("head_sha", { length: 64 }).notNull(),
  headRef: varchar("head_ref", { length: 255 }),
  baseRef: varchar("base_ref", { length: 255 }),
  cloneUrl: text("clone_url"),
  mirrorRepoId: uuid("mirror_repo_id").references(() => repositories.id, { onDelete: "set null" }),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "set null" }),
  checkRunId: varchar("check_run_id", { length: 32 }),
  state: varchar("state", { length: 24 }).notNull().default("received"), // received | mirrored | reviewing | reported | error
  lastError: text("last_error"),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byPr: uniqueIndex("github_pr_mirrors_pr_uniq").on(t.owner, t.repo, t.prNumber),
  byChange: index("github_pr_mirrors_change_idx").on(t.changeId),
}));
export type GithubPrMirror = typeof githubPrMirrors.$inferSelect;

// Issue routing (N5): per-repo rules mapping an issue label (or "*" for any) to
// an agent that gets auto-assigned when a matching issue is created or labeled.
// Purely mechanical (label → assignment), highest-priority match wins; no LLM.
export const issueRoutingRules = pgTable("issue_routing_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  label: varchar("label", { length: 120 }).notNull(), // exact label, or "*" for any
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(0), // higher wins when multiple rules match
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRepo: index("issue_routing_repo_idx").on(t.repoId),
  uniq: uniqueIndex("issue_routing_repo_label_uniq").on(t.repoId, t.label),
}));
export type IssueRoutingRule = typeof issueRoutingRules.$inferSelect;

// Visual regression baselines (N4). Per (repo, surface-key) the approved
// screenshot blob; a verify run captures the same surface, compares against this
// baseline (pixelmatch, in-harness via visual-diff.mjs), attaches the diff as
// evidence, and flags drift. First capture with no baseline seeds it. The PNG
// bytes live in the evidence object store; this row is the pointer + provenance.
export const visualBaselines = pgTable("visual_baselines", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  key: varchar("key", { length: 200 }).notNull(), // surface identifier (route/name)
  blobId: varchar("blob_id", { length: 128 }).notNull(), // object-store blob id of the baseline PNG
  headCommit: varchar("head_commit", { length: 64 }),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byRepoKey: uniqueIndex("visual_baselines_repo_key_uniq").on(t.repoId, t.key),
}));
export type VisualBaseline = typeof visualBaselines.$inferSelect;
