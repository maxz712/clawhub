import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ForbiddenError, ValidationError } from "../services/errors.js";
import { getOrgFleet } from "../services/fleet.js";

// GET /api/v1/fleet?org=<id> — the org fleet snapshot (members only).
export function createFleetRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.query("org");
    if (!orgId) throw new ValidationError("org query param required");
    const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, p.userId))).limit(1))[0];
    if (!m) throw new ForbiddenError("not an org member");
    return c.json(await getOrgFleet(db, orgId));
  });
  return app;
}
