import type { Context } from "hono";
import type { DB } from "../models/db.js";
import { auditEvents } from "../models/schema.js";

export type AuditCategory =
  | "auth" | "repo" | "change" | "review" | "merge" | "issue" | "agent"
  | "secret" | "ci" | "release" | "webhook" | "policy" | "admin" | "other";

export interface AuditInput {
  repoId?: string | null;
  actorKind: "agent" | "human" | "system";
  actorId?: string | null;
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

export function ipFromContext(c: Context): string | null {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? null;
}

export function userAgentFromContext(c: Context): string | null {
  return c.req.header("user-agent") ?? null;
}
