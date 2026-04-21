import { and, eq, gte } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { presenceHeartbeats } from "../models/schema.js";

const STALE_MS = 30_000;

export async function heartbeat(db: DB, changeId: string, actor: { kind: "agent" | "human" | "system"; id: string }): Promise<void> {
  await db.insert(presenceHeartbeats).values({
    changeId,
    actorKind: actor.kind,
    actorId: actor.id,
    lastSeen: new Date(),
  }).onConflictDoUpdate({
    target: [presenceHeartbeats.changeId, presenceHeartbeats.actorKind, presenceHeartbeats.actorId],
    set: { lastSeen: new Date() },
  });
}

export async function viewers(db: DB, changeId: string): Promise<Array<{ kind: "agent" | "human" | "system"; id: string; lastSeen: Date }>> {
  const since = new Date(Date.now() - STALE_MS);
  const rows = await db.select().from(presenceHeartbeats).where(and(eq(presenceHeartbeats.changeId, changeId), gte(presenceHeartbeats.lastSeen, since)));
  return rows.map(r => ({ kind: r.actorKind, id: r.actorId, lastSeen: r.lastSeen }));
}
