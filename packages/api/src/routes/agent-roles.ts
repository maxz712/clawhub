import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, repositories } from "../models/schema.js";
import type { AgentRole } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForWrite } from "../services/repo-access.js";
import type { NamespaceKind } from "../services/namespace.js";
import { AuthError, ForbiddenError, ValidationError } from "../services/errors.js";
import { isSecretsKeyConfigured } from "../services/secrets.js";
import {
  createRole, deleteRole, deployRoleToOrg, deployRoleToRepo, getRole, listRoleDeployments,
  listRoles, listTemplates, redactDeployment, redactRole, undeployRole, type CreateRoleInput,
} from "../services/agent-roles.js";

async function assertOrgAdmin(db: DB, userId: string, orgId: string): Promise<void> {
  const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.role, "admin"))).limit(1))[0];
  if (!m) throw new ForbiddenError("org admin required");
}
async function assertOrgMember(db: DB, userId: string, orgId: string): Promise<void> {
  const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))).limit(1))[0];
  if (!m) throw new ForbiddenError("not an org member");
}

/** The caller may manage a role iff they own it (user role) or admin its org (org role). */
async function assertRoleOwner(db: DB, userId: string, role: AgentRole): Promise<void> {
  if (role.ownerType === "user" && role.ownerId === userId) return;
  if (role.ownerType === "org" && role.ownerId) { await assertOrgAdmin(db, userId, role.ownerId); return; }
  throw new ForbiddenError("not your role");
}

/** A human may deploy to a repo iff they own its namespace / admin its org. */
async function assertRepoWrite(db: DB, userId: string, repo: typeof repositories.$inferSelect, ns: { kind: NamespaceKind; id: string }): Promise<void> {
  if (ns.kind === "user" && ns.id === userId) return;
  if (ns.kind === "agent") {
    const a = (await db.select().from(agents).where(and(eq(agents.id, ns.id), eq(agents.associatedUserId, userId))).limit(1))[0];
    if (a) return;
  }
  if (ns.kind === "org") { await assertOrgAdmin(db, userId, ns.id); return; }
  throw new ForbiddenError("forbidden");
}

// Mounted at /api/v1/roles. Org roles are addressed via ?org=<id> / body.org=<id>
// (avoids shadowing the /api/v1/orgs router).
export function createAgentRoleRoutes(db: DB): Hono {
  const app = new Hono();

  // PUBLIC: curated role templates (the marketplace surface). Registered before
  // the auth middleware so it stays open.
  app.get("/templates", async c => {
    return c.json({ templates: (await listTemplates(db)).map(redactRole) });
  });

  app.use("*", authMiddleware);
  function requireUser(c: { get: (k: "tokenPayload") => unknown }): string {
    const p = c.get("tokenPayload") as { kind: string; userId?: string };
    if (p.kind !== "user" || !p.userId) throw new AuthError("user token required");
    return p.userId;
  }

  // List roles: ?org=<id> for an org's roles (member), else the caller's own.
  app.get("/", async c => {
    const userId = requireUser(c);
    const org = c.req.query("org");
    if (org) { await assertOrgMember(db, userId, org); return c.json({ roles: (await listRoles(db, "org", org)).map(redactRole) }); }
    return c.json({ roles: (await listRoles(db, "user", userId)).map(redactRole) });
  });

  // Create a role (from a template via `template`, or fully custom). body.org=<id>
  // makes it org-owned (admin only); else it is the caller's personal role.
  app.post("/", async c => {
    if (!isSecretsKeyConfigured()) throw new ValidationError("server missing CLAWHUB_SECRETS_KEY");
    const userId = requireUser(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const owner = body.org
      ? (await (async () => { await assertOrgAdmin(db, userId, String(body.org)); return { ownerType: "org" as const, ownerId: String(body.org), createdByUserId: userId }; })())
      : { ownerType: "user" as const, ownerId: userId, createdByUserId: userId };
    const role = await createRole(db, roleInput(body, owner));
    return c.json({ role: redactRole(role) }, 201);
  });

  app.get("/:id", async c => {
    const userId = requireUser(c);
    const role = await getRole(db, c.req.param("id"));
    await assertRoleOwner(db, userId, role);
    return c.json({ role: redactRole(role) });
  });

  app.delete("/:id", async c => {
    const userId = requireUser(c);
    const role = await getRole(db, c.req.param("id"));
    await assertRoleOwner(db, userId, role);
    await deleteRole(db, role.id);
    return c.json({ ok: true });
  });

  // Deploy to a single repo (`repo: "ns/name"`) or across an org (`org: id`, optional `topic`).
  app.post("/:id/deploy", async c => {
    const userId = requireUser(c);
    const role = await getRole(db, c.req.param("id"));
    await assertRoleOwner(db, userId, role);
    const body = await c.req.json().catch(() => ({})) as { repo?: string; org?: string; topic?: string };
    if (body.repo) {
      const [ns, name] = body.repo.split("/");
      if (!ns || !name) throw new ValidationError("repo must be ns/name");
      const { repo, namespace } = await resolveRepoForWrite(db, ns, name, c.get("tokenPayload"));
      await assertRepoWrite(db, userId, repo, namespace);
      const sa = await deployRoleToRepo(db, role, repo.id, userId);
      return c.json({ deployed: 1, deployment: redactDeployment(sa) }, 201);
    }
    if (body.org) {
      await assertOrgAdmin(db, userId, body.org);
      return c.json(await deployRoleToOrg(db, role, body.org, userId, { topic: body.topic }), 201);
    }
    throw new ValidationError("one of repo or org is required");
  });

  app.get("/:id/deployments", async c => {
    const userId = requireUser(c);
    const role = await getRole(db, c.req.param("id"));
    await assertRoleOwner(db, userId, role);
    return c.json({ deployments: (await listRoleDeployments(db, role.id)).map(redactDeployment) });
  });

  app.delete("/:id/deployments", async c => {
    const userId = requireUser(c);
    const role = await getRole(db, c.req.param("id"));
    await assertRoleOwner(db, userId, role);
    let repoId: string | undefined;
    const repoQ = c.req.query("repo");
    if (repoQ) { const [ns, name] = repoQ.split("/"); const { repo } = await resolveRepoForWrite(db, ns, name, c.get("tokenPayload")); repoId = repo.id; }
    return c.json(await undeployRole(db, role.id, { repoId }));
  });

  return app;
}

function roleInput(body: Record<string, unknown>, owner: { ownerType: "user" | "org"; ownerId: string; createdByUserId: string }): CreateRoleInput {
  return {
    ...owner,
    template: body.template as string | undefined,
    name: body.name as string | undefined,
    description: body.description as string | null | undefined,
    capability: body.capability as string | undefined,
    specialization: body.specialization as string | null | undefined,
    image: body.image as string | undefined,
    command: body.command as string | null | undefined,
    mode: body.mode as string | undefined,
    trigger: body.trigger as string | undefined,
    cron: body.cron as string | null | undefined,
    event: body.event as string | null | undefined,
    intervalSec: body.intervalSec as number | undefined,
    task: body.task as string | undefined,
    llmProvider: body.llmProvider as string | undefined,
    llmBaseUrl: body.llmBaseUrl as string | null | undefined,
    llmApiKey: body.llmApiKey as string | null | undefined,
    memoryMb: body.memoryMb as number | undefined,
    cpus: body.cpus as number | undefined,
    timeoutSec: body.timeoutSec as number | undefined,
    minTrustTier: body.minTrustTier as string | undefined,
    earnedAutonomy: body.earnedAutonomy as boolean | undefined,
    agentName: body.agentName as string | undefined,
  };
}
