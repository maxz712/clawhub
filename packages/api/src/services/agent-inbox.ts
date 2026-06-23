import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentMessages, agents, type AgentMessage } from "../models/schema.js";

// An inbox message annotated with the agent it was addressed to. Used by the
// human-supervision view so a human sees one stream across all their agents.
export interface UserInboxMessage extends AgentMessage {
  agentId: string;
  agentName: string;
}

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

// The human-supervision read: every inbox message across the agents a user
// owns/claims (claimed = associatedUserId, or its service user), newest first,
// each labeled with the owning agent. Mirrors `inbox` (the per-agent query) but
// unions over the caller's agents. No agent token required — this is the human's
// cross-agent view, so it must NOT widen what a single agent can see: it is
// strictly scoped to agents the caller owns.
export async function userInbox(
  db: DB,
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<UserInboxMessage[]> {
  const owned = await db.select({ id: agents.id, name: agents.name }).from(agents)
    .where(or(eq(agents.associatedUserId, userId), eq(agents.serviceUserId, userId)));
  if (!owned.length) return [];
  const nameById = new Map(owned.map(a => [a.id, a.name]));
  const limit = opts.limit ?? 100;
  const conds = [inArray(agentMessages.toAgentId, [...nameById.keys()])];
  if (opts.unreadOnly) conds.push(eq(agentMessages.read, false));
  const rows = await db.select().from(agentMessages)
    .where(and(...conds)).orderBy(desc(agentMessages.createdAt)).limit(limit);
  return rows.map(m => ({ ...m, agentId: m.toAgentId, agentName: nameById.get(m.toAgentId) ?? "" }));
}

export async function markRead(db: DB, agentId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  // Scope to the SPECIFIC message ids the caller named — previously this ignored
  // `ids` and marked ALL of the agent's messages read. The toAgentId predicate
  // stays so an agent can only mark its own messages.
  await db.update(agentMessages).set({ read: true })
    .where(and(eq(agentMessages.toAgentId, agentId), inArray(agentMessages.id, ids)));
}
