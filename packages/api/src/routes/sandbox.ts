import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { sandboxes } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import type { SandboxService } from "../services/sandbox.js";
import { isAgentKilled } from "../services/kill-switch.js";

export function createSandboxRoutes(db: DB, sandbox: SandboxService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only");
    if (await isAgentKilled(db, p.agentId)) throw new AuthError("agent_kill_switch_engaged");
    const body = await c.req.json().catch(() => ({})) as { repoId?: string; ref?: string; image?: string; command?: string; timeoutMs?: number };
    if (!body.repoId || !body.command) throw new ValidationError("repoId + command required");
    const row = await sandbox.launch({
      agentId: p.agentId,
      repoId: body.repoId,
      ref: body.ref,
      image: body.image,
      command: body.command,
      timeoutMs: body.timeoutMs,
    });
    return c.json({ sandbox: row }, 201);
  });

  app.get("/:id", async c => {
    const row = await sandbox.get(c.req.param("id"));
    if (!row) throw new NotFoundError("sandbox");
    return c.json({ sandbox: row });
  });

  app.post("/:id/kill", async c => {
    await sandbox.kill(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/", async c => {
    const p = c.get("tokenPayload");
    const rows = p.kind === "agent"
      ? await db.select().from(sandboxes).where(eq(sandboxes.agentId, p.agentId)).orderBy(desc(sandboxes.createdAt)).limit(50)
      : await db.select().from(sandboxes).orderBy(desc(sandboxes.createdAt)).limit(50);
    return c.json({ sandboxes: rows });
  });

  return app;
}
