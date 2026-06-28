import { Hono } from "hono";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, repositories, sandboxes } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { TokenPayload } from "../services/auth.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { requireRepoWrite } from "../services/repo-access.js";
import type { SandboxService } from "../services/sandbox.js";
import { isAgentKilled } from "../services/kill-switch.js";

// Images a sandbox may run. Without an allowlist an agent could `docker run` an
// arbitrary attacker image on the runner host. Override with a comma-separated
// CLAWHUB_SANDBOX_ALLOWED_IMAGES.
const ALLOWED_IMAGES = (process.env.CLAWHUB_SANDBOX_ALLOWED_IMAGES ??
  "node:20-slim,node:20,node:22-slim,node:22,python:3.12-slim,python:3.11-slim,alpine:3.20")
  .split(",").map(s => s.trim()).filter(Boolean);

// Max concurrently-running sandboxes per agent (DoS guard on the runner host).
const MAX_RUNNING_PER_AGENT = Number(process.env.CLAWHUB_SANDBOX_MAX_RUNNING ?? 5);

// Agent ids a human caller owns (claimed or service user) — the set of agents
// whose sandboxes they may view/kill.
async function ownedAgentIds(db: DB, userId: string): Promise<string[]> {
  const rows = await db.select({ id: agents.id }).from(agents)
    .where(or(eq(agents.associatedUserId, userId), eq(agents.serviceUserId, userId)));
  return rows.map(r => r.id);
}

// Does this caller govern the sandbox's owning agent?
async function callerOwnsSandboxAgent(db: DB, p: TokenPayload, sandboxAgentId: string): Promise<boolean> {
  if (p.kind === "agent") return p.agentId === sandboxAgentId;
  return (await ownedAgentIds(db, p.userId)).includes(sandboxAgentId);
}

export function createSandboxRoutes(db: DB, sandbox: SandboxService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only");
    if (await isAgentKilled(db, p.agentId)) throw new AuthError("agent_kill_switch_engaged");
    const body = await c.req.json().catch(() => ({})) as { repoId?: string; ref?: string; image?: string; command?: string; timeoutMs?: number };
    if (!body.repoId || !body.command) throw new ValidationError("repoId + command required");

    // Authorize the target repo — the agent must have write on it, not merely
    // be authenticated. repoId is otherwise a free-form, unauthorized label.
    const repo = (await db.select().from(repositories).where(eq(repositories.id, body.repoId)).limit(1))[0];
    if (!repo) throw new NotFoundError("repo");
    await requireRepoWrite(db, repo, p);

    // Pin the image to the allowlist so a tenant can't run an arbitrary image.
    if (body.image && !ALLOWED_IMAGES.includes(body.image)) {
      throw new ValidationError(`image not allowed; permitted: ${ALLOWED_IMAGES.join(", ")}`);
    }

    // Per-agent concurrency cap on the shared runner host.
    const running = await db.select({ id: sandboxes.id }).from(sandboxes)
      .where(and(eq(sandboxes.agentId, p.agentId), eq(sandboxes.status, "running")));
    if (running.length >= MAX_RUNNING_PER_AGENT) throw new ForbiddenError("sandbox concurrency limit reached");

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
    const p = c.get("tokenPayload");
    const row = await sandbox.get(c.req.param("id"));
    // 404 (not 403) on a sandbox the caller doesn't own — no existence leak.
    if (!row || !(await callerOwnsSandboxAgent(db, p, row.agentId))) throw new NotFoundError("sandbox");
    return c.json({ sandbox: row });
  });

  app.post("/:id/kill", async c => {
    const p = c.get("tokenPayload");
    const row = await sandbox.get(c.req.param("id"));
    if (!row || !(await callerOwnsSandboxAgent(db, p, row.agentId))) throw new NotFoundError("sandbox");
    await sandbox.kill(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind === "agent") {
      const rows = await db.select().from(sandboxes).where(eq(sandboxes.agentId, p.agentId)).orderBy(desc(sandboxes.createdAt)).limit(50);
      return c.json({ sandboxes: rows });
    }
    // A human sees only the sandboxes of agents they govern — not the whole instance.
    const ids = await ownedAgentIds(db, p.userId);
    if (!ids.length) return c.json({ sandboxes: [] });
    const rows = await db.select().from(sandboxes).where(inArray(sandboxes.agentId, ids)).orderBy(desc(sandboxes.createdAt)).limit(50);
    return c.json({ sandboxes: rows });
  });

  return app;
}
