import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentMessages, type AgentMessage } from "../models/schema.js";

export interface SendMessageInput {
  toAgentId: string;
  from: { kind: "agent" | "human" | "system"; id: string };
  changeId?: string | null;
  kind?: "feedback" | "review_request" | "handoff" | "task" | "context";
  body: Record<string, unknown>;
}

export async function sendMessage(db: DB, input: SendMessageInput): Promise<AgentMessage> {
  const [row] = await db.insert(agentMessages).values({
    toAgentId: input.toAgentId,
    fromKind: input.from.kind,
    fromId: input.from.id,
    changeId: input.changeId ?? null,
    kind: input.kind ?? "feedback",
    body: input.body,
  }).returning();
  return row;
}

export async function inbox(db: DB, agentId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<AgentMessage[]> {
  const conds = [eq(agentMessages.toAgentId, agentId)];
  if (opts.unreadOnly) conds.push(eq(agentMessages.read, false));
  return db.select().from(agentMessages).where(and(...conds)).orderBy(desc(agentMessages.createdAt)).limit(opts.limit ?? 100);
}

export async function markRead(db: DB, agentId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.update(agentMessages).set({ read: true }).where(and(eq(agentMessages.toAgentId, agentId)));
}
