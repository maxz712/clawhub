import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentRoles, agents, marketplaceAgents, repoCollaborators, repositories, standingAgents } from "../models/schema.js";
import type { AgentRole, StandingAgent } from "../models/schema.js";
import { seal, unseal } from "./secrets.js";
import { hashToken, matchesHash, randomToken, signToken } from "./auth.js";
import { assertValidMode, createStandingAgent, redactStanding, DEFAULT_HARNESS_IMAGE } from "./standing-agents.js";
import { enrollAgent, getAgentTierInOrg } from "./org-registry.js";
import { log } from "./logger.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.js";

const TIER_RANK: Record<string, number> = { sandbox: 0, standard: 1, trusted: 2 };

// An Agent Role is a deployable agent template. Deploying a Role to a repo (or
// fanning it out across an org) creates standing_agents from the template — so a
// solo dev deploys one and a team deploys a fleet through the same mechanism, and
// a reviewer/specialist is just a Role with capability=reviewer. ClawHub never
// runs the model: a Role still runs the user's BYO container. See docs/agent-roles.md.

export type RoleCapability = "worker" | "reviewer" | "triager" | "specialist";

/** The reference-harness image. A Role defaults to it; deploy can override.
 * Single source of truth lives in standing-agents.ts (the standing-agent attach
 * path defaults to the same image); re-exported here for existing importers. */
export { DEFAULT_HARNESS_IMAGE };

/** Mode + trigger defaults derived from a capability (overridable). */
function capabilityDefaults(cap: RoleCapability): { mode: string; trigger: string; event?: string; cron?: string } {
  switch (cap) {
    case "reviewer": return { mode: "review", trigger: "event", event: "change.opened" };
    case "triager": return { mode: "triage", trigger: "event", event: "issue.opened" };
    case "specialist": return { mode: "worker", trigger: "schedule", cron: "0 6 * * 1" }; // weekly Mon 06:00 UTC
    case "worker":
    default: return { mode: "worker", trigger: "continuous" };
  }
}

// --- Curated templates (the marketplace surface) ---------------------------

export interface RoleTemplate {
  slug: string; name: string; description: string; capability: RoleCapability;
  specialization?: string; task: string; trigger?: string; event?: string; cron?: string;
  intervalSec?: number; earnedAutonomy?: boolean; minTrustTier?: string;
  // Override the mode the capability would otherwise pick (e.g. a reviewer that
  // VERIFIES end-to-end runs in `verify`, not `review`).
  mode?: string;
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  { slug: "worker", name: "Worker", capability: "worker",
    description: "A general autonomous engineer: picks up issues + small improvements, opens one focused Change at a time.",
    task: "Pick the next worthwhile increment (an assigned issue, a failing test, a small improvement). Make one focused change with tests, then open a Change with Intent/Risk trailers. One Change at a time.",
    trigger: "continuous", intervalSec: 3600, earnedAutonomy: true },
  { slug: "security-reviewer", name: "Security reviewer", capability: "reviewer", specialization: "security",
    description: "Reviews every opened Change for security vulnerabilities and submits a verdict.",
    task: "Review this Change for security issues: injection, authz/authn gaps, secret leakage, unsafe deserialization, SSRF, path traversal. Submit a code-basis review verdict; request changes on any real finding with the file:line.",
    trigger: "event", event: "change.opened", minTrustTier: "standard" },
  { slug: "perf-reviewer", name: "Performance reviewer", capability: "reviewer", specialization: "performance",
    description: "Reviews opened Changes for performance regressions (N+1s, hot-path allocations, unbounded work).",
    task: "Review this Change for performance regressions: N+1 queries, unbounded loops/queries, hot-path allocations, missing indexes, sync work on hot paths. Submit a code-basis verdict.",
    trigger: "event", event: "change.opened" },
  { slug: "verified-reviewer", name: "Verified reviewer", capability: "reviewer", specialization: "verification", mode: "verify",
    description: "Runs every opened Change end-to-end (API + UI + CLI), screenshots the behavior, and reports a server-trusted verification. Pairs with the verifiedAutonomy merge policy to auto-approve + auto-merge verified Changes — with no human.",
    task: "Verify this Change END-TO-END, don't just read it. Boot the app, then for EVERY behavior the diff changes run a real check: call the API endpoint (curl), drive the UI (clawhub-browse) and screenshot it, run the relevant CLI/tests. Report each check's outcome as the verification JSON. Only report success when you actually exercised the behavior and it did the right thing.",
    trigger: "event", event: "change.opened", minTrustTier: "standard" },
  // Empty task on purpose: the human gives the goal one of two ways — set the agent's task
  // (a prompt) OR assign it an issue. With no task the harness (run_develop) grabs an assigned
  // issue (?assigned=me); with a task it builds that. Either way it then drives the real UI.
  { slug: "developer", name: "UI developer", capability: "worker", specialization: "ui", mode: "develop",
    description: "Builds UI features end-to-end and AUTONOMOUSLY. Give it a goal one of two ways: set its task (a prompt) or assign it an issue — then it implements the feature and LOOKS AT and CLICKS the running UI in a real browser, iterating until it is right, before opening ONE Change with screenshot evidence. No human in the loop until review.",
    task: "",
    trigger: "continuous", intervalSec: 3600, earnedAutonomy: false },
  { slug: "dependency-bot", name: "Dependency bot", capability: "specialist", specialization: "deps",
    description: "Keeps dependencies current: weekly bumps with tests, one Change.",
    task: "Update dependencies to current safe versions. Run the test suite. Open a Change with the bumps + test results; keep it small and reversible. Pin anything that breaks.",
    trigger: "schedule", cron: "0 6 * * 1", earnedAutonomy: true },
  { slug: "triager", name: "Issue triager", capability: "triager",
    description: "Triages new issues: labels, prioritizes, links duplicates.",
    task: "Triage this new issue: add labels, set a priority, link likely duplicates, and ask for a repro if missing. Don't write code.",
    trigger: "event", event: "issue.opened" },
  // The FRONT of the autonomous Loop: an agent that lives in the codebase and FILES
  // issues (the triager only reacts to issues once opened). Runs on a SCHEDULE (daily)
  // and files ONE well-scoped issue per tick — the bounded input that feeds the
  // developer. Worker capability with a set task ⇒ run_worker executes the task; the
  // task only calls the ClawHub API (no file edits), so nothing is pushed.
  { slug: "issue-scout", name: "Issue scout", capability: "worker", specialization: "scout",
    description: "Lives in the codebase and FILES issues — the front of the autonomous Loop. On a daily schedule it scans the repo for the single highest-value improvement (a real bug, a missing test, risky tech-debt, or a small feature) and files ONE well-scoped ClawHub issue for a developer agent to pick up. Files issues; never writes code.",
    task: "Scan this repository for the SINGLE highest-value improvement right now — a real bug, a missing test, risky tech-debt, or a small well-scoped feature. FIRST GET $CLAWHUB_URL/api/v1/repos/$CLAWHUB_REPO/issues?status=open (header 'Authorization: Bearer $CLAWHUB_TOKEN') so you do not file a duplicate. THEN file exactly ONE issue: POST $CLAWHUB_URL/api/v1/repos/$CLAWHUB_REPO/issues with header 'Authorization: Bearer $CLAWHUB_TOKEN' and JSON body {\"title\":\"<crisp imperative title>\",\"body\":\"<motivation + acceptance criteria + the file:line to change, actionable enough for an autonomous developer to implement without you>\",\"labels\":[\"scout\"]}. File AT MOST ONE issue per run. Do NOT write or push code.",
    trigger: "schedule", cron: "0 7 * * *" },
  // mode MUST be "reflect" explicitly — capabilityDefaults(worker) is "worker",
  // which made a deployed Reflector silently run worker mode (never consolidating).
  // Debounce-until-quiet trigger: reflect fires once per activity burst, after the
  // repo settles for intervalSec — not a fixed nightly cron that fires on idle
  // nights and misses busy afternoons.
  { slug: "reflector", name: "Reflector", capability: "worker", mode: "reflect",
    description: "After repo activity settles, distills episode memories into durable conventions (server-side + .clawhub/memory).",
    task: "Read recent episode memories + consolidation candidates for this repo. Distill repeated lessons into durable `convention`/`decision` memories, superseding the episodes they subsume, and curate .clawhub/memory/MEMORY.md.",
    trigger: "quiet", intervalSec: 7200 },
];

/** Idempotently insert/update the system role templates. Called on boot. */
export async function seedRoleTemplates(db: DB): Promise<void> {
  for (const t of ROLE_TEMPLATES) {
    const d = capabilityDefaults(t.capability);
    const values = {
      ownerType: "system", ownerId: null as string | null,
      name: t.name, slug: t.slug, description: t.description,
      capability: t.capability as AgentRole["capability"], specialization: t.specialization ?? null,
      image: DEFAULT_HARNESS_IMAGE, mode: t.mode ?? (t.capability === "reviewer" ? "review" : t.capability === "triager" ? "triage" : d.mode),
      trigger: t.trigger ?? d.trigger, cron: t.cron ?? d.cron ?? null, event: t.event ?? d.event ?? null,
      intervalSec: t.intervalSec ?? 3600, task: t.task,
      minTrustTier: t.minTrustTier ?? "sandbox", earnedAutonomy: t.earnedAutonomy ?? false,
      isTemplate: true, isPublic: true,
    };
    // `slug` is a PARTIAL unique index (WHERE slug is not null) — the conflict
    // target must restate that predicate via targetWhere or Postgres can't infer
    // the arbiter (and the upsert silently never matches → templates never seed).
    await db.insert(agentRoles).values(values).onConflictDoUpdate({
      target: agentRoles.slug, targetWhere: sql`slug is not null`,
      // mode/trigger/cron/event/intervalSec included so template FIXES propagate
      // to existing installs (e.g. the reflector's missing mode:"reflect") —
      // deployed standing agents are separate rows and are never touched here.
      set: {
        description: values.description, task: values.task, image: values.image,
        mode: values.mode, trigger: values.trigger, cron: values.cron, event: values.event, intervalSec: values.intervalSec,
      },
    });
  }
  log("info", "role_templates_seeded", { count: ROLE_TEMPLATES.length });
}

/**
 * Seed the public marketplace catalog from the curated role templates so the
 * marketplace browse surface isn't permanently empty (app.ts seeded role
 * templates but never marketplace_agents). One verified, free, system-published
 * entry per template; idempotent on slug. Installing one clones the matching
 * Role template to the chosen target (see routes/marketplace.ts).
 */
export async function seedMarketplaceAgents(db: DB): Promise<void> {
  for (const t of ROLE_TEMPLATES) {
    await db.insert(marketplaceAgents).values({
      slug: t.slug,
      name: t.name,
      tagline: t.description.length > 240 ? t.description.slice(0, 237) + "…" : t.description,
      description: t.description,
      capabilities: [t.capability, ...(t.specialization ? [t.specialization] : [])],
      pricingModel: "free",
      publisherUserId: null,
      agentId: null,
      verified: true,
    }).onConflictDoUpdate({
      target: marketplaceAgents.slug,
      set: { name: t.name, tagline: t.description.slice(0, 240), description: t.description, verified: true },
    });
  }
  log("info", "marketplace_agents_seeded", { count: ROLE_TEMPLATES.length });
}

export async function listTemplates(db: DB): Promise<AgentRole[]> {
  return db.select().from(agentRoles).where(and(eq(agentRoles.isTemplate, true), eq(agentRoles.isPublic, true))).orderBy(agentRoles.name);
}

// --- Owned roles (created from a template or custom) ------------------------

export interface CreateRoleInput {
  ownerType: "user" | "org";
  ownerId: string;
  template?: string;          // clone config from this template slug
  name?: string;
  description?: string | null;
  capability?: string;
  specialization?: string | null;
  image?: string;
  command?: string | null;
  mode?: string;
  trigger?: string;
  cron?: string | null;
  event?: string | null;
  intervalSec?: number;
  task?: string;
  llmProvider?: string;
  cli?: string;   // claude | copilot | codex | gemini
  model?: string | null;   // pin the CLI's --model (e.g. sonnet/opus); null → CLI default
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;
  // "platform" routes the deployed agent through the metering gateway on ClawHub's
  // key (N5 — the zero-setup Loop). INTERNAL callers only (loop install); the
  // public role routes never forward it, per D2.
  keySource?: "byo" | "platform";
  memoryMb?: number; cpus?: number; timeoutSec?: number;
  minTrustTier?: string;
  earnedAutonomy?: boolean;
  agentName?: string;         // dedicated agent name (else generated from the role name)
  createdByUserId: string;
}

const SLUG_RE = /[^a-z0-9]+/g;
export function slugify(s: string): string { return s.toLowerCase().replace(SLUG_RE, "-").replace(/^-|-$/g, "").slice(0, 40) || "role"; }

/** Mint a dedicated agent for a role + return its live token (to seal). */
async function mintRoleAgent(db: DB, roleName: string, capability: RoleCapability, ownerUserId: string, agentName?: string): Promise<{ agentId: string; token: string }> {
  // Globally-unique agent name — append a short random so two "security-reviewer"
  // roles don't collide on agents.name.
  const base = agentName ? slugify(agentName) : slugify(roleName);
  const name = `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "agt"}`;
  const [agent] = await db.insert(agents).values({
    name,
    tokenHash: await hashToken(randomToken(12)),
    associatedUserId: ownerUserId,
    gitAuthorName: roleName,
    gitAuthorEmail: `${base}@agents.useclawhub.com`,
    // A pure reviewer can review but not push.
    capabilities: { push: capability !== "reviewer", review: true },
  }).returning();
  const token = signToken({ kind: "agent", agentId: agent.id, name: agent.name });
  await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, agent.id));
  return { agentId: agent.id, token };
}

// Cap the number of owned (non-template) roles per owner. Each role mints a
// dedicated agent + sealed creds, so an unbounded create surface (marketplace
// install, POST /roles) could exhaust the globally-unique agents.name space +
// credential tables. A generous ceiling no real user/org hits.
const MAX_ROLES_PER_OWNER = 100;

export async function createRole(db: DB, input: CreateRoleInput): Promise<AgentRole> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(agentRoles)
    .where(and(eq(agentRoles.ownerType, input.ownerType), eq(agentRoles.ownerId, input.ownerId), eq(agentRoles.isTemplate, false)));
  if (Number(n) >= MAX_ROLES_PER_OWNER) {
    throw new ValidationError(`role limit reached — at most ${MAX_ROLES_PER_OWNER} roles per ${input.ownerType}`);
  }
  // Start from a template's config if given.
  let tmpl: AgentRole | undefined;
  if (input.template) {
    tmpl = (await db.select().from(agentRoles).where(and(eq(agentRoles.slug, input.template), eq(agentRoles.isTemplate, true))).limit(1))[0];
    if (!tmpl) throw new NotFoundError(`role template "${input.template}"`);
  }
  const capability = (input.capability ?? tmpl?.capability ?? "worker") as RoleCapability;
  if (!["worker", "reviewer", "triager", "specialist"].includes(capability)) throw new ValidationError("bad capability");
  const d = capabilityDefaults(capability);
  const name = input.name ?? tmpl?.name ?? "Role";
  const mode = input.mode ?? tmpl?.mode ?? d.mode;
  // An unknown mode must be a 400, not a stored string that mis-selects the
  // dispatch branch (e.g. an unrecognized mode falling into the privileged verify
  // tier). Same enum the standing-agents create path enforces (#215).
  assertValidMode(mode);
  const trigger = input.trigger ?? tmpl?.trigger ?? d.trigger;

  const { agentId, token } = await mintRoleAgent(db, name, capability, input.createdByUserId, input.agentName);
  const tokenSeal = seal(token);
  const llmSeal = input.llmApiKey ? seal(input.llmApiKey) : null;

  const [role] = await db.insert(agentRoles).values({
    ownerType: input.ownerType, ownerId: input.ownerId,
    name, slug: null, description: input.description ?? tmpl?.description ?? null,
    capability: capability as AgentRole["capability"], specialization: input.specialization ?? tmpl?.specialization ?? null,
    image: input.image ?? tmpl?.image ?? DEFAULT_HARNESS_IMAGE,
    command: input.command ?? null, mode,
    trigger, cron: input.cron ?? tmpl?.cron ?? d.cron ?? null, event: input.event ?? tmpl?.event ?? d.event ?? null,
    intervalSec: input.intervalSec ?? tmpl?.intervalSec ?? 3600,
    task: input.task ?? tmpl?.task ?? "",
    llmProvider: input.llmProvider ?? "anthropic", cli: input.cli ?? tmpl?.cli ?? "claude", model: input.model ?? null, llmBaseUrl: input.llmBaseUrl ?? null,
    keySource: input.keySource ?? "byo",
    agentId, llmCiphertext: llmSeal?.ciphertext ?? null, llmNonce: llmSeal?.nonce ?? null,
    tokenCiphertext: tokenSeal.ciphertext, tokenNonce: tokenSeal.nonce,
    memoryMb: input.memoryMb ?? 1024, cpus: input.cpus ?? 1, timeoutSec: input.timeoutSec ?? 1800,
    minTrustTier: input.minTrustTier ?? tmpl?.minTrustTier ?? "sandbox",
    earnedAutonomy: input.earnedAutonomy ?? tmpl?.earnedAutonomy ?? false,
    isTemplate: false, isPublic: false,
    createdByUserId: input.createdByUserId,
  }).returning();
  log("info", "role_created", { id: role.id, capability, ownerType: input.ownerType });
  return role;
}

export async function listRoles(db: DB, ownerType: "user" | "org", ownerId: string): Promise<AgentRole[]> {
  return db.select().from(agentRoles).where(and(eq(agentRoles.ownerType, ownerType), eq(agentRoles.ownerId, ownerId), eq(agentRoles.isTemplate, false))).orderBy(desc(agentRoles.createdAt));
}

export async function getRole(db: DB, id: string): Promise<AgentRole> {
  const r = (await db.select().from(agentRoles).where(eq(agentRoles.id, id)).limit(1))[0];
  if (!r) throw new NotFoundError("role");
  return r;
}

export async function deleteRole(db: DB, id: string): Promise<void> {
  await undeployRole(db, id);
  await db.delete(agentRoles).where(eq(agentRoles.id, id));
}

/** Strip sealed creds before returning a role over the API. */
export function redactRole(r: AgentRole) {
  const { tokenCiphertext, tokenNonce, llmCiphertext, llmNonce, ...rest } = r;
  return { ...rest, hasLlmKey: !!llmCiphertext };
}

// --- Deploy ----------------------------------------------------------------

/** Unseal a role's agent push token + LLM key, verifying the token is still live. */
function roleCreds(role: AgentRole): { token: string; llmApiKey: string | null } {
  if (role.isTemplate) throw new ValidationError("cannot deploy a template directly — create a role from it first");
  if (!role.tokenCiphertext || !role.tokenNonce) throw new ValidationError("role has no agent token");
  let token = "";
  try { token = unseal(role.tokenCiphertext, role.tokenNonce); } catch { throw new ValidationError("role agent token unrecoverable (sealing key changed)"); }
  let llmApiKey: string | null = null;
  if (role.llmCiphertext && role.llmNonce) { try { llmApiKey = unseal(role.llmCiphertext, role.llmNonce); } catch { llmApiKey = null; } }
  return { token, llmApiKey };
}

/** Deploy a role to one repo: create a standing_agent from the role's template + creds. */
export async function deployRoleToRepo(db: DB, role: AgentRole, repoId: string, userId: string): Promise<StandingAgent> {
  const { token, llmApiKey } = roleCreds(role);
  // The role's token must still match its agent's live hash (an external rotation
  // would otherwise fail-closed deep in dispatch). Surface it clearly up front.
  if (role.agentId) {
    const agent = (await db.select({ tokenHash: agents.tokenHash }).from(agents).where(eq(agents.id, role.agentId)).limit(1))[0];
    if (!agent || !(await matchesHash(token, agent.tokenHash))) {
      throw new ValidationError("role's agent token was rotated externally — re-create the role to re-issue it");
    }
  }
  try {
    return await createStandingAgent(db, {
      // The standing-agent name must satisfy NAME_RE (no spaces/caps). Role names
      // are human-facing ("Issue triager"), so slugify — otherwise deploying any
      // multi-word/curated template fails with "bad name".
      repoId, name: slugify(role.name), image: role.image, command: role.command,
      trigger: role.trigger, cron: role.cron, event: role.event, intervalSec: role.intervalSec,
      mode: role.mode, model: role.model, task: role.task,
      llmProvider: role.llmProvider, cli: role.cli, llmBaseUrl: role.llmBaseUrl, llmApiKey,
      keySource: role.keySource === "platform" ? "platform" : undefined,
      memoryMb: role.memoryMb, cpus: role.cpus, timeoutSec: role.timeoutSec,
      agentToken: token,
      grantRole: role.capability === "reviewer" ? "reviewer" : "writer",
      roleId: role.id,
      roleOwnedAgentId: role.agentId ?? undefined, // a co-admin may deploy a shared org role
      createdByUserId: userId,
    });
  } catch (e) {
    // Already deployed here (unique repoId+name) — surface a clean 409, not a 500.
    if ((e as { code?: string }).code === "23505") throw new ConflictError(`role "${role.name}" is already deployed to this repo`);
    throw e;
  }
}

export interface OrgDeployResult { deployed: number; alreadyDeployed: number; skipped: Array<{ repo: string; reason: string }>; }

/**
 * Fan a role out across an org's repos (optionally filtered by topic). The role's
 * one agent gets a standing_agent + grant per repo, and is enrolled in the org
 * registry so it shows in the fleet. Per-repo failures are collected, never abort
 * the deploy; a repo it's already on counts as alreadyDeployed (not an error).
 */
export async function deployRoleToOrg(db: DB, role: AgentRole, orgId: string, userId: string, opts: { topic?: string } = {}): Promise<OrgDeployResult> {
  // Trust gate: if the role demands more than sandbox AND its agent has a KNOWN
  // lower tier in this org, refuse. A fresh agent (no tier yet) is allowed and
  // enrolled at sandbox — it earns promotion via evals/quality over time.
  if (role.minTrustTier !== "sandbox" && role.agentId) {
    const tier = await getAgentTierInOrg(db, orgId, role.agentId);
    if (tier && (TIER_RANK[tier] ?? 0) < (TIER_RANK[role.minTrustTier] ?? 0)) {
      throw new ForbiddenError(`role requires trust tier "${role.minTrustTier}" but its agent is "${tier}" in this org`);
    }
  }
  const repos = await db.select().from(repositories).where(and(eq(repositories.namespaceType, "org"), eq(repositories.namespaceId, orgId)));
  const targets = opts.topic ? repos.filter(r => Array.isArray(r.topics) && (r.topics as string[]).includes(opts.topic!)) : repos;
  const result: OrgDeployResult = { deployed: 0, alreadyDeployed: 0, skipped: [] };
  for (const repo of targets) {
    try { await deployRoleToRepo(db, role, repo.id, userId); result.deployed++; }
    catch (e) {
      if (e instanceof ConflictError) { result.alreadyDeployed++; continue; } // idempotent — not a failure
      result.skipped.push({ repo: repo.name, reason: (e as Error).message });
    }
  }
  // Enroll the role's agent only if it actually landed somewhere (no enrollment for a 0-repo no-op).
  if ((result.deployed > 0 || result.alreadyDeployed > 0) && role.agentId) await enrollAgent(db, orgId, role.agentId, "sandbox", userId).catch(() => {});
  log("info", "role_deployed_to_org", { roleId: role.id, orgId, deployed: result.deployed, alreadyDeployed: result.alreadyDeployed, skipped: result.skipped.length });
  return result;
}

/** All standing-agent deployments of a role. */
export async function listRoleDeployments(db: DB, roleId: string): Promise<StandingAgent[]> {
  return db.select().from(standingAgents).where(eq(standingAgents.roleId, roleId)).orderBy(desc(standingAgents.createdAt));
}

export function redactDeployment(s: StandingAgent) { return redactStanding(s); }

/**
 * Remove a role's deployments (optionally a single repo's), AND revoke the
 * repo_collaborators grant the deploy added — but only on repos where no other
 * standing agent for the role's agent remains (the agent may be deployed via a
 * different role on the same repo). Otherwise the agent keeps push rights forever.
 */
export async function undeployRole(db: DB, roleId: string, opts: { repoId?: string } = {}): Promise<{ removed: number; revoked: number }> {
  const role = (await db.select({ agentId: agentRoles.agentId }).from(agentRoles).where(eq(agentRoles.id, roleId)).limit(1))[0];
  const where = opts.repoId
    ? and(eq(standingAgents.roleId, roleId), eq(standingAgents.repoId, opts.repoId))
    : eq(standingAgents.roleId, roleId);
  const rows = await db.delete(standingAgents).where(where).returning({ id: standingAgents.id, repoId: standingAgents.repoId });
  let revoked = 0;
  const agentId = role?.agentId;
  if (agentId) {
    const repoIds = Array.from(new Set(rows.map(r => r.repoId).filter((x): x is string => !!x)));
    for (const repoId of repoIds) {
      const stillThere = await db.select({ id: standingAgents.id }).from(standingAgents)
        .where(and(eq(standingAgents.agentId, agentId), eq(standingAgents.repoId, repoId))).limit(1);
      if (!stillThere.length) {
        const del = await db.delete(repoCollaborators).where(and(eq(repoCollaborators.repoId, repoId), eq(repoCollaborators.agentId, agentId))).returning({ id: repoCollaborators.id });
        revoked += del.length;
      }
    }
  }
  return { removed: rows.length, revoked };
}
