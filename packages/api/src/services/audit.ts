import type { Context } from "hono";
import type { DB } from "../models/db.js";
import { auditEvents } from "../models/schema.js";
import { clientIp } from "../middleware/rate-limit-redis.js";

export type AuditCategory =
  | "auth" | "repo" | "change" | "review" | "merge" | "issue" | "agent"
  | "secret" | "ci" | "release" | "webhook" | "policy" | "admin" | "other";

export interface AuditInput {
  repoId?: string | null;
  actorKind: "agent" | "human" | "system";
  actorId?: string | null;
  /** Denormalized handle — survives GDPR scrubs of actorId (v3 identities). */
  actorHandle?: string | null;
  action: string;
  category?: AuditCategory;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export class AuditLog {
  constructor(private db: DB) {}

  async record(e: AuditInput): Promise<void> {
    try {
      await this.db.insert(auditEvents).values({
        repoId: e.repoId ?? null,
        actorKind: e.actorKind,
        actorId: e.actorId ?? null,
        actorHandle: e.actorHandle ?? null,
        action: e.action,
        category: e.category ?? "other",
        metadata: e.metadata ?? {},
        ip: e.ip ?? null,
        userAgent: e.userAgent ?? null,
      });
    } catch {
      // Audit must never break the request path. Failures are logged only.
    }
  }
}

// Shared, importable audit-log instances. The rest of the app logs through
// `getAuditLog(db)` rather than constructing its own `new AuditLog(db)` so every
// caller (merges, rollbacks, reviews, collaborator/secret/token changes) writes
// to the same place with the same record() contract. Cached per DB handle —
// there is normally one DB per process, but tests may pass distinct fakes.
const auditLogByDb = new WeakMap<DB, AuditLog>();

/** Get the shared AuditLog for a DB handle, creating it once. */
export function getAuditLog(db: DB): AuditLog {
  let inst = auditLogByDb.get(db);
  if (!inst) {
    inst = new AuditLog(db);
    auditLogByDb.set(db, inst);
  }
  return inst;
}

// Delegates to the ONE canonical resolver (#159) — the audit record's actor IP
// must be the socket peer, not a spoofable X-Forwarded-For[0]/X-Real-IP header
// (this feeds audit_events.ip for secret rotation, role changes, SCIM, merges).
export function ipFromContext(c: Context): string | null {
  const ip = clientIp(c);
  return ip === "anon" ? null : ip;
}

export function userAgentFromContext(c: Context): string | null {
  return c.req.header("user-agent") ?? null;
}
