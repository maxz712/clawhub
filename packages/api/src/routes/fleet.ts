import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ForbiddenError } from "../services/errors.js";
import { getMyFleet, getOrgFleet } from "../services/fleet.js";

// GET /api/v1/fleet           — the caller's PERSONAL fleet (their own agents).
// GET /api/v1/fleet?org=<id>  — an org fleet snapshot (members only).
// Same shape either way, so the dashboard renders one pane at any scale.
export function createFleetRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.query("org");
    if (!orgId) return c.json(await getMyFleet(db, p.userId));
    const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, p.userId))).limit(1))[0];
    if (!m) throw new ForbiddenError("not an org member");
    return c.json(await getOrgFleet(db, orgId));
  });
  return app;
}
