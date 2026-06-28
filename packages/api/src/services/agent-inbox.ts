import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentMessages, agents, orgMembers, repoCollaborators, repositories, type AgentMessage } from "../models/schema.js";
import { ForbiddenError, NotFoundError } from "./errors.js";

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

// Security (cross-tenant prompt-injection guard): an inbox message is a delivery
// channel for tasks/instructions, so we admit a sender→recipient pair ONLY when a
// relationship exists. A sender may message a recipient agent when it (a) owns or
// IS the recipient, (b) shares an org with the recipient's owner, or (c) shares a
// repo grant with it. `system` senders are internal and always admitted. Without
// this, any self-registered agent (or user) could inject into any agent's inbox.
async function assertSenderMayReach(db: DB, from: SendMessageInput["from"], toAgentId: string): Promise<void> {
  if (from.kind === "system") return;

  const recipient = (await db.select({
    id: agents.id,
    associatedUserId: agents.associatedUserId,
    serviceUserId: agents.serviceUserId,
  }).from(agents).where(eq(agents.id, toAgentId)).limit(1))[0];
  if (!recipient) throw new NotFoundError("agent");

  // (a) the sender is, owns, or governs the recipient agent.
  if (from.kind === "agent" && from.id === recipient.id) return;
  const recipientOwners = [recipient.associatedUserId, recipient.serviceUserId].filter((u): u is string => !!u);

  // Resolve the sender's owning user id(s): a human sender is its own user; an
  // agent sender inherits its claimed/service users.
  let senderUserIds: string[];
  let senderAgentId: string | null = null;
  if (from.kind === "human") {
    senderUserIds = [from.id];
  } else {
    senderAgentId = from.id;
    const senderAgent = (await db.select({
      associatedUserId: agents.associatedUserId,
      serviceUserId: agents.serviceUserId,
    }).from(agents).where(eq(agents.id, from.id)).limit(1))[0];
    senderUserIds = senderAgent
      ? [senderAgent.associatedUserId, senderAgent.serviceUserId].filter((u): u is string => !!u)
      : [];
  }

  // (a, cont.) the sender owns/governs the recipient (shares an owning user).
  if (senderUserIds.some(u => recipientOwners.includes(u))) return;

  // (b) the sender's user(s) and the recipient's owner(s) co-member an org.
  if (senderUserIds.length && recipientOwners.length) {
    const myOrgs = await db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(inArray(orgMembers.userId, senderUserIds));
    if (myOrgs.length) {
      const shared = (await db.select({ orgId: orgMembers.orgId }).from(orgMembers)
        .where(and(inArray(orgMembers.userId, recipientOwners), inArray(orgMembers.orgId, myOrgs.map(o => o.orgId)))).limit(1))[0];
      if (shared) return;
    }
  }

  // (c) the sender and recipient share a repo grant: both are collaborators on a
  // common repo (agent grant or, for a human sender, a human grant / namespace ownership).
  const recipientRepos = (await db.select({ repoId: repoCollaborators.repoId }).from(repoCollaborators)
    .where(eq(repoCollaborators.agentId, recipient.id))).map(r => r.repoId);
  if (recipientRepos.length) {
    if (senderAgentId) {
      const shared = (await db.select({ repoId: repoCollaborators.repoId }).from(repoCollaborators)
        .where(and(eq(repoCollaborators.agentId, senderAgentId), inArray(repoCollaborators.repoId, recipientRepos))).limit(1))[0];
      if (shared) return;
    }
    if (senderUserIds.length) {
      const sharedHuman = (await db.select({ repoId: repoCollaborators.repoId }).from(repoCollaborators)
        .where(and(inArray(repoCollaborators.userId, senderUserIds), inArray(repoCollaborators.repoId, recipientRepos))).limit(1))[0];
      if (sharedHuman) return;
      const ownedRepo = (await db.select({ id: repositories.id }).from(repositories)
        .where(and(eq(repositories.namespaceType, "user"), inArray(repositories.namespaceId, senderUserIds), inArray(repositories.id, recipientRepos))).limit(1))[0];
      if (ownedRepo) return;
    }
  }

  throw new ForbiddenError("no relationship between sender and recipient agent");
}

export async function sendMessage(db: DB, input: SendMessageInput): Promise<AgentMessage> {
  await assertSenderMayReach(db, input.from, input.toAgentId);
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
