import { Hono } from "hono";
import { desc, eq, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { statusIncidents } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { TokenPayload } from "../services/auth.js";
import { isPlatformAdminEmail } from "./admin.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";

/** The public `overall` field is read straight off an incident's severity, so
 *  the accepted set is enforced at the boundary — never trust the TS type. */
const SEVERITIES = ["minor", "major", "critical"] as const;
type Severity = (typeof SEVERITIES)[number];

/** `:id` goes into a `uuid` column — a non-UUID would make Postgres throw a
 *  500 instead of the 404 a bogus id deserves. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `/api/v1/status` mount only AUTHENTICATES (authMiddleware). Incident
 *  writes are platform control-plane state — the instance's outage truth, read
 *  unauthenticated at `/api/v1/public/status` — so they AUTHORIZE against the
 *  same platform-admin allowlist as flags.ts / attestations.ts / security.ts.
 *  Without this any signed-up user could fabricate a public outage or resolve
 *  the operator's real one out from under them (#126). */
function adminUser(c: { get: (k: "tokenPayload") => TokenPayload }): { userId: string; email?: string } {
  const p = c.get("tokenPayload");
  if (p.kind !== "user") throw new AuthError("users only");
  if (!isPlatformAdminEmail(p.email)) throw new AuthError("not_admin");
  return p;
}

export function createStatusRoutes(db: DB): { pub: Hono; admin: Hono } {
  const pub = new Hono();
  pub.get("/", async c => {
    const active = await db.select().from(statusIncidents).where(isNull(statusIncidents.resolvedAt)).orderBy(desc(statusIncidents.startedAt));
    const recent = await db.select().from(statusIncidents).orderBy(desc(statusIncidents.startedAt)).limit(20);
    return c.json({
      overall: active.length === 0 ? "operational" : active[0].severity,
      active,
      recent,
    });
  });

  const admin = new Hono();
  admin.use("*", authMiddleware);

  admin.post("/", async c => {
    const p = adminUser(c);
    const body = await c.req.json().catch(() => ({})) as { title?: string; body?: string; severity?: string };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!title || !text) throw new ValidationError("title + body required");
    if (title.length > 200) throw new ValidationError("title must be 200 characters or fewer");
    const severity = (body.severity ?? "minor") as Severity;
    if (!SEVERITIES.includes(severity)) {
      throw new ValidationError(`severity must be one of ${SEVERITIES.join(", ")}`);
    }
    const [row] = await db.insert(statusIncidents).values({ title, body: text, severity }).returning();
    void getAuditLog(db).record({
      actorKind: "human", actorId: p.userId, actorHandle: p.email ?? null,
      action: "status.incident.opened", category: "admin",
      metadata: { incidentId: row.id, severity: row.severity, title: row.title },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ incident: row }, 201);
  });

  admin.post("/:id/resolve", async c => {
    const p = adminUser(c);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw new NotFoundError("incident");
    const [row] = await db.update(statusIncidents)
      .set({ resolvedAt: new Date(), status: "resolved" })
      .where(eq(statusIncidents.id, id))
      .returning();
    // An unscoped UPDATE that matched nothing used to answer {ok:true}, so a
    // typo'd or already-gone incident was indistinguishable from a real resolve.
    if (!row) throw new NotFoundError("incident");
    void getAuditLog(db).record({
      actorKind: "human", actorId: p.userId, actorHandle: p.email ?? null,
      action: "status.incident.resolved", category: "admin",
      metadata: { incidentId: row.id, severity: row.severity, title: row.title },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, incident: row });
  });

  return { pub, admin };
}
