import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForWrite, resolveRepoForAdmin } from "../services/repo-access.js";
import { AuthError } from "../services/errors.js";
import { installLoop, uninstallLoop, setLoopEnabled, loopStatus, type Autonomy, type InstallLoopInput } from "../services/loop.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";

// The autonomous Loop (M8). One-click bundle of developer + verified-reviewer with
// a policy dial. User-authed; install/uninstall need repo ADMIN (they mint agents
// + rewrite the merge policy), kill/resume need write.
export function createLoopRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/loop", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    return c.json({ status: await loopStatus(db, repo.id) });
  });

  app.post("/:ns/:repo/loop", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("only a human can install the Loop");
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), p);
    const body = await c.req.json().catch(() => ({})) as { autonomy?: string; includeTriager?: boolean; includeScout?: boolean; cadence?: string; devKind?: string };
    const autonomy = (["review_only", "low", "medium"].includes(body.autonomy ?? "") ? body.autonomy : "review_only") as Autonomy;
    const cadence = (["daily", "twice_daily", "hourly", "weekly"].includes(body.cadence ?? "") ? body.cadence : undefined) as InstallLoopInput["cadence"];
    const devKind = (body.devKind === "code" || body.devKind === "ui" ? body.devKind : undefined) as InstallLoopInput["devKind"];
    const loop = await installLoop(db, { repoId: repo.id, userId: p.userId, autonomy, includeTriager: !!body.includeTriager, includeScout: !!body.includeScout, cadence, devKind });
    await getAuditLog(db).record({
      repoId: repo.id, actorKind: "human", actorId: p.userId,
      action: "loop.installed", category: "change", metadata: { autonomy, cadence: cadence ?? "daily", scout: !!body.includeScout },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ loop }, 201);
  });

  app.post("/:ns/:repo/loop/kill", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await setLoopEnabled(db, repo.id, false);
    return c.json({ ok: true });
  });

  app.post("/:ns/:repo/loop/resume", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await setLoopEnabled(db, repo.id, true);
    return c.json({ ok: true });
  });

  app.delete("/:ns/:repo/loop", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("only a human can uninstall the Loop");
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), p);
    const r = await uninstallLoop(db, repo.id);
    await getAuditLog(db).record({
      repoId: repo.id, actorKind: "human", actorId: p.userId,
      action: "loop.uninstalled", category: "change", metadata: { policyReverted: r.policyReverted },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, ...r });
  });

  return app;
}
