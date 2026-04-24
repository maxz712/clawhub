import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "@clawhub/api/db";
import { marketplaceAgents, marketplaceInstalls } from "../schema.js";
import { authMiddleware } from "@clawhub/api/middleware/auth";
import { AuthError, NotFoundError, ValidationError } from "@clawhub/api/errors";

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
    const body = await c.req.json().catch(() => ({})) as { orgId?: string; repoId?: string };
    await db.insert(marketplaceInstalls).values({
      marketplaceAgentId: ma.id,
      orgId: body.orgId ?? null,
      repoId: body.repoId ?? null,
      installedBy: p.userId,
    });
    await db.update(marketplaceAgents).set({ installs: sql`${marketplaceAgents.installs} + 1` }).where(eq(marketplaceAgents.id, ma.id));
    return c.json({ ok: true });
  });

  return { pub, auth };
}
