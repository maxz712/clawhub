import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForWrite, resolveRepoForAdmin } from "../services/repo-access.js";
import { AuthError } from "../services/errors.js";
import { installLoop, uninstallLoop, setLoopEnabled, loopStatus, LOOP_PRESETS, type Autonomy, type InstallLoopInput, type LoopRoleSpec } from "../services/loop.js";
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
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const CAD = ["daily", "twice_daily", "hourly", "weekly"];
    const autonomy = (["review_only", "low", "medium"].includes(String(body.autonomy ?? "")) ? body.autonomy : "review_only") as Autonomy;
    const cadence = (CAD.includes(String(body.cadence ?? "")) ? body.cadence : undefined) as InstallLoopInput["cadence"];
    const preset = (typeof body.preset === "string" && Object.prototype.hasOwnProperty.call(LOOP_PRESETS, body.preset) ? body.preset : undefined) as InstallLoopInput["preset"];
    const devKind = (body.devKind === "code" || body.devKind === "ui" ? body.devKind : undefined) as InstallLoopInput["devKind"];
    // Parse a per-role spec safely (custom prompt capped, cadence/devKind validated).
    const spec = (v: unknown): LoopRoleSpec | undefined => {
      if (v == null || typeof v !== "object") return undefined;
      const o = v as Record<string, unknown>;
      return {
        enabled: typeof o.enabled === "boolean" ? o.enabled : undefined,
        prompt: typeof o.prompt === "string" && o.prompt.trim() ? o.prompt.slice(0, 4000) : undefined,
        cadence: CAD.includes(String(o.cadence ?? "")) ? (o.cadence as LoopRoleSpec["cadence"]) : undefined,
        devKind: o.devKind === "code" || o.devKind === "ui" ? o.devKind : undefined,
      };
    };
    const loop = await installLoop(db, {
      repoId: repo.id, userId: p.userId, autonomy, preset, cadence, devKind,
      scout: spec(body.scout), developer: spec(body.developer), reviewer: spec(body.reviewer), triager: spec(body.triager),
      includeTriager: !!body.includeTriager, includeScout: !!body.includeScout,
      // N5 zero-setup Loop: an explicit opt-in by the repo ADMIN installing it.
      keySource: body.keySource === "platform" ? "platform" : "byo",
      // BYO key for the loop's roles — sealed at rest, never logged/echoed.
      llmApiKey: typeof body.llmApiKey === "string" && body.llmApiKey.trim() ? body.llmApiKey.trim() : undefined,
    });
    await getAuditLog(db).record({
      repoId: repo.id, actorKind: "human", actorId: p.userId,
      action: "loop.installed", category: "change", metadata: { autonomy, preset: preset ?? null, cadence: cadence ?? "daily" },
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
