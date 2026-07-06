import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { repositories, users } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import {
  identityActivity, identityByHandle, identityDirectoryEnabled, identityKey,
  userToIdentity, visibleIdentities,
} from "../services/identities.js";
import { namespaceNameOf } from "../services/namespace.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";

/**
 * v3 identities directory (docs/redesign-v3.md §1). User-token surface:
 *   GET  /api/v1/identities            — common-context directory (?q=)
 *   GET  /api/v1/identities/:handle    — profile + shared repos (404 if no
 *                                        shared context — no existence leak)
 *   GET  /api/v1/identities/:handle/activity
 *   PATCH /api/v1/identities/self      — the caller's own PROFILE (display
 *                                        name, avatar, bio). Credentials
 *                                        (email/password/2FA/tokens) stay on
 *                                        the account surface — deliberately
 *                                        separate (directory ≠ credential
 *                                        management).
 * Mounted at a specific prefix (app.ts) so use("*") auth can't shadow
 * later routers. Kill switch: CLAWHUB_DISABLE_IDENTITY_DIRECTORY=1.
 */
export function createIdentityRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.use("*", async (c, next) => {
    if (!identityDirectoryEnabled()) throw new NotFoundError("identities");
    await next();
  });

  app.get("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const limit = Math.min(200, Number(c.req.query("limit") ?? 100) || 100);
    const map = await visibleIdentities(db, p.userId);
    let rows = [...map.values()];
    if (q) rows = rows.filter(i => i.handle.toLowerCase().includes(q) || (i.displayName ?? "").toLowerCase().includes(q));
    rows.sort((a, b) => (a.kind === b.kind ? a.handle.localeCompare(b.handle) : a.kind === "human" ? -1 : 1));
    return c.json({
      identities: rows.slice(0, limit).map(i => ({ ...i, sharedRepoCount: i.sharedRepoIds.length, sharedRepoIds: undefined })),
    });
  });

  app.patch("/self", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const body = await c.req.json().catch(() => ({})) as { name?: unknown; avatarUrl?: unknown; bio?: unknown };
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") patch.name = body.name.trim().slice(0, 120) || null;
    if (typeof body.avatarUrl === "string") patch.avatarUrl = body.avatarUrl.trim().slice(0, 2000) || null;
    if (typeof body.bio === "string") patch.bio = body.bio.trim().slice(0, 2000) || null;
    if (!Object.keys(patch).length) throw new ValidationError("nothing to update (name, avatarUrl, bio)");
    const [row] = await db.update(users).set(patch).where(eq(users.id, p.userId)).returning();
    if (!row) throw new NotFoundError("user");
    void getAuditLog(db).record({
      actorKind: "human", actorId: p.userId, actorHandle: row.username ?? null,
      action: "identity.profile_updated", category: "auth",
      metadata: { fields: Object.keys(patch) },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ identity: userToIdentity(row) });
  });

  app.get("/:handle", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const identity = await identityByHandle(db, c.req.param("handle"));
    if (!identity) throw new NotFoundError("identity");
    const map = await visibleIdentities(db, p.userId);
    const visible = map.get(identityKey(identity.kind, identity.id));
    const isSelf = identity.kind === "human" && identity.id === p.userId;
    if (!visible && !isSelf) throw new NotFoundError("identity"); // no existence leak
    const sharedRepoIds = visible?.sharedRepoIds ?? [];
    const sharedRepos: Array<{ ns: string | null; name: string }> = [];
    for (const rid of sharedRepoIds.slice(0, 50)) {
      const r = (await db.select().from(repositories).where(eq(repositories.id, rid)).limit(1))[0];
      if (r) sharedRepos.push({ ns: await namespaceNameOf(db, r.namespaceType, r.namespaceId), name: r.name });
    }
    return c.json({ identity, sharedRepos });
  });

  app.get("/:handle/activity", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const identity = await identityByHandle(db, c.req.param("handle"));
    if (!identity) throw new NotFoundError("identity");
    const map = await visibleIdentities(db, p.userId);
    const isSelf = identity.kind === "human" && identity.id === p.userId;
    if (!map.get(identityKey(identity.kind, identity.id)) && !isSelf) throw new NotFoundError("identity");
    const limit = Math.min(200, Number(c.req.query("limit") ?? 50) || 50);
    const rows = await identityActivity(db, p.userId, identity, limit);
    return c.json({ activity: rows });
  });

  return app;
}
