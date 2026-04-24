import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { DB } from "@clawhub/api/db";
import { users } from "@clawhub/api/schema";
import { hashPassword } from "@clawhub/api/auth";
import { randomBytes } from "node:crypto";

// SCIM 2.0 — minimal Users endpoint. Auth is a shared bearer token
// (SCIM_TOKEN env) that IdPs like Okta / Azure AD use.

const SCIM_TOKEN = process.env.CLAWHUB_SCIM_TOKEN ?? "";

export function createScimRoutes(db: DB): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!SCIM_TOKEN || !match || match[1] !== SCIM_TOKEN) return c.json({ status: 401, detail: "unauthorized" }, 401);
    await next();
  });

  app.get("/ServiceProviderConfig", c => c.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer", description: "OAuth bearer" }],
  }));

  app.get("/Schemas", c => c.json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 1,
    Resources: [{
      id: "urn:ietf:params:scim:schemas:core:2.0:User",
      name: "User",
      attributes: [
        { name: "userName", type: "string", required: true },
        { name: "emails", type: "complex", multiValued: true, required: true },
        { name: "displayName", type: "string" },
        { name: "active", type: "boolean" },
      ],
    }],
  }));

  app.get("/Users", async c => {
    const filter = c.req.query("filter") ?? "";
    const emailMatch = filter.match(/userName\s+eq\s+"([^"]+)"/);
    const rows = emailMatch
      ? await db.select().from(users).where(eq(users.email, emailMatch[1])).limit(200)
      : await db.select().from(users).orderBy(desc(users.createdAt)).limit(200);
    return c.json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: rows.length,
      Resources: rows.map(toScimUser),
    });
  });

  app.get("/Users/:id", async c => {
    const row = (await db.select().from(users).where(eq(users.id, c.req.param("id"))).limit(1))[0];
    if (!row) return c.json({ status: 404 }, 404);
    return c.json(toScimUser(row));
  });

  app.post("/Users", async c => {
    const body = await c.req.json() as { userName?: string; displayName?: string; emails?: Array<{ value: string; primary?: boolean }> };
    const email = body.userName ?? body.emails?.find(e => e.primary)?.value ?? body.emails?.[0]?.value;
    if (!email) return c.json({ status: 400, detail: "email required" }, 400);
    const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    if (existing) return c.json(toScimUser(existing), 200);
    const pw = await hashPassword(randomBytes(32).toString("hex"));
    const [row] = await db.insert(users).values({ email, name: body.displayName ?? null, passwordHash: pw }).returning();
    return c.json(toScimUser(row), 201);
  });

  app.patch("/Users/:id", async c => {
    const body = await c.req.json() as { Operations?: Array<{ op: string; path?: string; value?: unknown }> };
    for (const op of body.Operations ?? []) {
      if (op.op.toLowerCase() === "replace" && op.path === "displayName") {
        await db.update(users).set({ name: String(op.value ?? "") }).where(eq(users.id, c.req.param("id")));
      }
    }
    const row = (await db.select().from(users).where(eq(users.id, c.req.param("id"))).limit(1))[0];
    return c.json(row ? toScimUser(row) : { status: 404 }, row ? 200 : 404);
  });

  app.delete("/Users/:id", async c => {
    await db.delete(users).where(eq(users.id, c.req.param("id")));
    return new Response(null, { status: 204 });
  });

  return app;
}

function toScimUser(u: { id: string; email: string; name: string | null; createdAt: Date }) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: u.id,
    userName: u.email,
    displayName: u.name,
    emails: [{ value: u.email, primary: true, type: "work" }],
    active: true,
    meta: { resourceType: "User", created: u.createdAt, location: `/api/v1/scim/v2/Users/${u.id}` },
  };
}
