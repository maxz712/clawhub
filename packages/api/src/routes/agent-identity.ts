import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { accessRoles, agents, llmKeys, repositories, standingAgents } from "../models/schema.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { hashToken, signToken } from "../services/auth.js";
import { seal, unseal } from "../services/secrets.js";
import { agentEmailDomain } from "../services/personal-agent.js";
import {
  createAccessRole, deleteAccessRole, ensureDefaultAccessRoles, updateAccessRole,
} from "../services/access-roles.js";
import { createStandingAgent } from "../services/standing-agents.js";
import { repoAccessFor } from "../services/repo-access.js";
import { LOOP_CADENCES } from "../services/loop.js";
import { platformProvider } from "../services/llm-catalog.js";
import { ensureLoopBudget, tenantForRepo } from "../services/platform-billing.js";

/**
 * v2 agents-ux (docs/agents-ux.md): the identity-centric management surface.
 *  - /llm-keys        — the BYO key VAULT (sealed; names only ever returned)
 *  - /access-roles    — permission profiles (defaults seeded on first list)
 *  - /agents/managed  — the ONE create flow: name + role + (local | deployed)
 * All user-token only: agents are created BY humans.
 */
export function createAgentIdentityRoutes(db: DB, _events: EventBus): { keys: Hono; roles: Hono; managed: Hono } {
  const keysApp = new Hono();
  const rolesApp = new Hono();
  const managedApp = new Hono();
  for (const a of [keysApp, rolesApp, managedApp]) a.use("*", authMiddleware);

  const requireUser = (c: { get: (k: "tokenPayload") => { kind: string; userId?: string; email?: string } }) => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user" || !p.userId) throw new AuthError("user token required — agents are managed by humans");
    return p as { kind: "user"; userId: string; email: string };
  };

  // ---- Key vault -----------------------------------------------------------

  keysApp.get("/", async c => {
    const p = requireUser(c);
    const rows = await db.select({ id: llmKeys.id, name: llmKeys.name, provider: llmKeys.provider, createdAt: llmKeys.createdAt })
      .from(llmKeys).where(eq(llmKeys.ownerUserId, p.userId));
    return c.json({ keys: rows });
  });

  keysApp.post("/", async c => {
    const p = requireUser(c);
    const body = await c.req.json().catch(() => ({})) as { name?: string; provider?: string; key?: string };
    const name = (body.name ?? "").trim();
    const key = (body.key ?? "").trim();
    if (!name) throw new ValidationError("name required");
    if (!key) throw new ValidationError("key required");
    if (key.length > 4096) throw new ValidationError("key too long");
    const provider = ["anthropic", "openai", "google", "openrouter", "other"].includes(body.provider ?? "") ? body.provider! : "anthropic";
    const sealed = seal(key);
    const row = (await db.insert(llmKeys).values({
      ownerUserId: p.userId, name: name.slice(0, 120), provider,
      ciphertext: sealed.ciphertext, nonce: sealed.nonce,
    }).returning({ id: llmKeys.id, name: llmKeys.name, provider: llmKeys.provider, createdAt: llmKeys.createdAt }))[0];
    return c.json({ key: row }, 201);
  });

  keysApp.delete("/:id", async c => {
    const p = requireUser(c);
    // Deployments keep their own sealed COPY (standing_agents.llmCiphertext),
    // so deleting a vault key never bricks a running agent.
    await db.delete(llmKeys).where(and(eq(llmKeys.id, c.req.param("id")), eq(llmKeys.ownerUserId, p.userId)));
    return c.json({ ok: true });
  });

  // ---- Access roles --------------------------------------------------------

  rolesApp.get("/", async c => {
    const p = requireUser(c);
    const roles = await ensureDefaultAccessRoles(db, p.userId);
    return c.json({ roles });
  });

  rolesApp.post("/", async c => {
    const p = requireUser(c);
    const body = await c.req.json().catch(() => ({}));
    const role = await createAccessRole(db, p.userId, body as Parameters<typeof createAccessRole>[2]);
    return c.json({ role }, 201);
  });

  rolesApp.patch("/:id", async c => {
    const p = requireUser(c);
    const body = await c.req.json().catch(() => ({}));
    const role = await updateAccessRole(db, p.userId, c.req.param("id"), body as Parameters<typeof updateAccessRole>[3]);
    return c.json({ role });
  });

  rolesApp.delete("/:id", async c => {
    const p = requireUser(c);
    await deleteAccessRole(db, p.userId, c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- The one create flow -------------------------------------------------

  managedApp.post("/managed", async c => {
    const p = requireUser(c);
    const body = await c.req.json().catch(() => ({})) as {
      name?: string; accessRoleId?: string;
      run?: "local" | "deployed";
      llmKeyId?: string; keySource?: "platform";
      repoIds?: string[];
      instructions?: string;
      cadence?: "daily" | "hourly" | "continuous" | "on_change";
      mode?: string; // develop | worker | verify — derived from the UI preset
    };

    const name = (body.name ?? "").trim();
    if (!name) throw new ValidationError("name required");
    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(name)) throw new ValidationError("bad name (letters, digits, - and _)");
    if ((await db.select({ id: agents.id }).from(agents).where(eq(agents.name, name)).limit(1))[0]) {
      throw new ValidationError("an agent with that name already exists");
    }
    if (!body.accessRoleId) throw new ValidationError("accessRoleId required — pick a role (it defines what the agent may do)");
    const role = (await db.select().from(accessRoles)
      .where(and(eq(accessRoles.id, body.accessRoleId), eq(accessRoles.ownerUserId, p.userId))).limit(1))[0];
    if (!role) throw new NotFoundError("access role");

    const run = body.run === "deployed" ? "deployed" : "local";
    const perms = role.permissions as { push?: boolean; review?: boolean };

    // Validate EVERYTHING before creating the identity — a failed deployment
    // must not leave an orphaned half-created agent behind.
    let deployPlan: { repos: Array<typeof repositories.$inferSelect>; llmApiKey: string | null; llmProvider: string; platform: boolean } | null = null;
    if (run === "deployed") {
      const repoIds = Array.isArray(body.repoIds) ? body.repoIds.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
      if (!repoIds.length) throw new ValidationError("pick at least one repo to run on");
      const roleScope = role.repoScope === "selected" ? (role.repoIds as string[]) : null;
      const platform = body.keySource === "platform";
      if (platform) {
        // Same gate as installLoop (N5/D10): only when this instance runs
        // platform inference; the Loop cost-center lands before dispatch.
        if (platformProvider() === "openrouter" ? !process.env.CLAWHUB_PLATFORM_OPENAI_KEY : !process.env.CLAWHUB_PLATFORM_ANTHROPIC_KEY) {
          throw new ValidationError("platform inference is not configured on this instance — pick a key from your vault instead");
        }
      }
      let llmApiKey: string | null = null;
      let llmProvider = "anthropic";
      if (!platform) {
        if (!body.llmKeyId) throw new ValidationError("pick a key from your vault, or the platform LLM");
        const keyRow = (await db.select().from(llmKeys)
          .where(and(eq(llmKeys.id, body.llmKeyId), eq(llmKeys.ownerUserId, p.userId))).limit(1))[0];
        if (!keyRow) throw new NotFoundError("llm key");
        llmApiKey = unseal(keyRow.ciphertext, keyRow.nonce);
        llmProvider = keyRow.provider === "openai" || keyRow.provider === "openrouter" ? "openai" : keyRow.provider === "google" ? "google" : "anthropic";
      }
      const repos = await db.select().from(repositories).where(inArray(repositories.id, repoIds));
      if (repos.length !== repoIds.length) throw new NotFoundError("repo");
      for (const repo of repos) {
        const access = await repoAccessFor(db, repo, { kind: "user", userId: p.userId, email: p.email });
        if (access !== "write" && access !== "admin") throw new ForbiddenError(`you cannot deploy to ${repo.name}`);
        if (roleScope && !roleScope.includes(repo.id)) throw new ValidationError(`repo ${repo.name} is outside the role's scope`);
      }
      deployPlan = { repos, llmApiKey, llmProvider, platform };
    }

    // Create the identity. Human-created (v2): associated + attributed to the
    // creator; constrained by the chosen role.
    const agent = (await db.insert(agents).values({
      name,
      tokenHash: "pending",
      isPersonal: false,
      associatedUserId: p.userId,
      createdByUserId: p.userId,
      accessRoleId: role.id,
      gitAuthorName: name,
      gitAuthorEmail: `${name}@${agentEmailDomain()}`,
      capabilities: { push: perms.push !== false, review: perms.review !== false },
    }).returning())[0];
    const token = signToken({ kind: "agent", agentId: agent.id, name: agent.name });
    await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, agent.id));

    if (run === "local") {
      // You run it: paste the token into your tool once. Shown exactly once.
      return c.json({ agent: { id: agent.id, name: agent.name }, token, run }, 201);
    }

    // ClawHub runs it: one standing deployment per pointed repo, all sharing
    // this ONE identity + token. No container knobs — hardened defaults only.
    const { repos, llmApiKey, llmProvider, platform } = deployPlan!;
    const cadence = body.cadence ?? "daily";
    const trigger = cadence === "continuous" ? "continuous" : cadence === "on_change" ? "event" : "schedule";
    const cron = cadence === "daily" ? LOOP_CADENCES.daily : cadence === "hourly" ? LOOP_CADENCES.hourly : null;
    const mode = ["develop", "worker", "verify", "review", "triage"].includes(body.mode ?? "") ? body.mode! : "develop";
    const grantRole = perms.push === false ? "reviewer" as const : "writer" as const;

    const deployed: Array<{ repoId: string; standingAgentId: string }> = [];
    for (const repo of repos) {
      const sa = await createStandingAgent(db, {
        repoId: repo.id,
        name: `${name}-${repo.name}`.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").slice(0, 120),
        trigger, cron, event: trigger === "event" ? "change.opened" : null,
        intervalSec: 3600,
        mode,
        task: (body.instructions ?? "").slice(0, 8000),
        llmProvider,
        llmApiKey,
        agentToken: token,
        grantRole,
        keySource: platform ? "platform" : "byo",
        createdByUserId: p.userId,
      });
      if (platform) await ensureLoopBudget(db, await tenantForRepo(db, repo.id));
      if (body.llmKeyId) {
        await db.update(standingAgents).set({ llmKeyId: body.llmKeyId }).where(eq(standingAgents.id, sa.id));
      }
      deployed.push({ repoId: repo.id, standingAgentId: sa.id });
    }

    // Deployed agents never surface the token — the server holds it sealed.
    return c.json({ agent: { id: agent.id, name: agent.name }, run, deployed }, 201);
  });

  return { keys: keysApp, roles: rolesApp, managed: managedApp };
}
