import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { marketplaceAgents, marketplaceInstalls, orgMembers } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { ROLE_TEMPLATES, createRole } from "../services/agent-roles.js";
import { isSecretsKeyConfigured } from "../services/secrets.js";

export function createMarketplaceRoutes(db: DB): { pub: Hono; auth: Hono } {
  const pub = new Hono();

  pub.get("/", async c => {
    const q = c.req.query("q")?.toLowerCase();
    const rows = await db.select().from(marketplaceAgents).orderBy(desc(marketplaceAgents.installs)).limit(200);
    const filtered = q
      ? rows.filter(r => r.name.toLowerCase().includes(q) || (r.tagline?.toLowerCase().includes(q) ?? false))
      : rows;
    return c.json({ agents: filtered });
  });

  pub.get("/:slug", async c => {
    const row = (await db.select().from(marketplaceAgents).where(eq(marketplaceAgents.slug, c.req.param("slug"))).limit(1))[0];
    if (!row) throw new NotFoundError("marketplace agent");
    return c.json({ agent: row });
  });

  const auth = new Hono();
  auth.use("*", authMiddleware);

  auth.post("/publish", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { slug?: string; agentId?: string; name?: string; tagline?: string; description?: string; capabilities?: string[]; pricingModel?: string };
    if (!body.slug || !body.name) throw new ValidationError("slug + name required");
    const [row] = await db.insert(marketplaceAgents).values({
      slug: body.slug,
      agentId: body.agentId ?? null,
      name: body.name,
      tagline: body.tagline ?? null,
      description: body.description ?? null,
      capabilities: body.capabilities ?? [],
      pricingModel: body.pricingModel ?? "free",
      publisherUserId: p.userId,
    }).onConflictDoUpdate({
      target: marketplaceAgents.slug,
      set: {
        name: body.name,
        tagline: body.tagline ?? null,
        description: body.description ?? null,
        capabilities: body.capabilities ?? [],
        pricingModel: body.pricingModel ?? "free",
      },
    }).returning();
    return c.json({ agent: row }, 201);
  });

  auth.post("/:slug/install", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const ma = (await db.select().from(marketplaceAgents).where(eq(marketplaceAgents.slug, c.req.param("slug"))).limit(1))[0];
    if (!ma) throw new NotFoundError("marketplace agent");
    const body = await c.req.json().catch(() => ({})) as { orgId?: string; llmApiKey?: string };

    // AUTHORIZE the target up front (always), before recording anything: an
    // org install requires ORG ADMIN. (repoId is no longer accepted — the install
    // creates a deployable Role in the org/personal scope; deploying to a repo is
    // a separate, repo-write-gated step from the fleet/roles view.) This stops a
    // caller from attributing installs to an org they aren't an admin of.
    if (body.orgId) {
      const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, body.orgId), eq(orgMembers.userId, p.userId))).limit(1))[0];
      if (!m || m.role !== "admin") throw new ForbiddenError("org admin required to install into an org");
    }

    // A catalog entry that maps to a curated Role template actually CREATES a
    // deployable Role (a dedicated agent + sealed creds) in the chosen scope —
    // not the old no-op that recorded a row and ran nothing. The caller then
    // supplies the LLM key (now or at deploy) + deploys it from the fleet / roles
    // view. Entries with no backing template (custom publishes) just record the
    // install.
    let roleId: string | null = null;
    const isTemplate = ROLE_TEMPLATES.some(t => t.slug === ma.slug);
    if (isTemplate && isSecretsKeyConfigured()) {
      const owner = body.orgId
        ? { ownerType: "org" as const, ownerId: body.orgId, createdByUserId: p.userId }
        : { ownerType: "user" as const, ownerId: p.userId, createdByUserId: p.userId };
      const role = await createRole(db, { ...owner, template: ma.slug, name: ma.name, llmApiKey: body.llmApiKey ?? null });
      roleId = role.id;
    }

    await db.insert(marketplaceInstalls).values({
      marketplaceAgentId: ma.id,
      orgId: body.orgId ?? null,
      repoId: null,
      installedBy: p.userId,
    });
    await db.update(marketplaceAgents).set({ installs: sql`${marketplaceAgents.installs} + 1` }).where(eq(marketplaceAgents.id, ma.id));
    return c.json({ ok: true, roleId });
  });

  return { pub, auth };
}
