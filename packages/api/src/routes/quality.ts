import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError } from "../services/errors.js";
import { computeAgentQuality, getQuality, recomputeAll } from "../services/agent-quality.js";

// Platform admins (CLAWHUB_ADMIN_EMAILS) may act on any agent + run fleet-wide
// recomputes. Mirrors routes/admin.ts's gate.
const ADMIN_SET = new Set((process.env.CLAWHUB_ADMIN_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
function isAdmin(p: { kind: string; email?: string }): boolean {
  return p.kind === "user" && !!p.email && ADMIN_SET.has(p.email.toLowerCase());
}

export function createQualityRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // Quality scores are per-agent governance data. Without this gate any user
  // could read OR force-recompute ANY agent's score. The caller must own the
  // target agent (claimed = associatedUserId, or its service user) — or be a
  // platform admin. An agent may act on itself. Missing agent → 404.
  async function requireAgentControl(c: Context, agentId: string): Promise<void> {
    const p = c.get("tokenPayload");
    if (p.kind === "agent") {
      if (p.agentId !== agentId) throw new AuthError("agent_scope");
      return;
    }
    if (isAdmin(p)) return;
    const a = (await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, agentId), or(eq(agents.associatedUserId, p.userId), eq(agents.serviceUserId, p.userId)))).limit(1))[0];
    if (!a) throw new NotFoundError("agent");
  }

  app.get("/agents/:id/quality", async c => {
    await requireAgentControl(c, c.req.param("id"));
    const cached = await getQuality(db, c.req.param("id"));
    if (cached) return c.json({ quality: cached, cached: true });
    const fresh = await computeAgentQuality(db, c.req.param("id"));
    return c.json({ quality: fresh, cached: false });
  });

  app.post("/agents/:id/quality/recompute", async c => {
    await requireAgentControl(c, c.req.param("id"));
    const fresh = await computeAgentQuality(db, c.req.param("id"));
    return c.json({ quality: fresh });
  });

  app.post("/quality/recompute-all", async c => {
    // Fleet-wide recompute touches every agent — platform-admin only.
    const p = c.get("tokenPayload");
    if (!isAdmin(p)) throw new AuthError("not_admin");
    const n = await recomputeAll(db);
    return c.json({ recomputed: n });
  });

  return app;
}
