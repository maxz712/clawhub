import { eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, mentions, users } from "../models/schema.js";

const MENTION_RE = /(?<![a-zA-Z0-9_/])@([a-zA-Z0-9][a-zA-Z0-9\-_]{1,60})/g;

export interface MentionSource {
  repoId?: string | null;
  sourceKind: "issue" | "issue_comment" | "review" | "review_comment" | "change";
  sourceId: string;
  author: { kind: "agent" | "human"; id: string };
}

export function extractMentions(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) out.add(m[1].toLowerCase());
  return Array.from(out);
}

export async function resolveAndRecordMentions(db: DB, text: string, src: MentionSource): Promise<Array<{ kind: "agent" | "human"; id: string; name: string }>> {
  const names = extractMentions(text);
  if (!names.length) return [];

  const agentRows = await db.select().from(agents).where(inArray(agents.name, names));
  const userRows = await db.select().from(users).where(inArray(users.username, names));

  const mentioned: Array<{ kind: "agent" | "human"; id: string; name: string }> = [];
  for (const a of agentRows) mentioned.push({ kind: "agent", id: a.id, name: a.name });
  for (const u of userRows) if (u.username) mentioned.push({ kind: "human", id: u.id, name: u.username });

  if (!mentioned.length) return [];

  await db.insert(mentions).values(mentioned.map(m => ({
    repoId: src.repoId ?? null,
    mentionedKind: m.kind,
    mentionedId: m.id,
    sourceKind: src.sourceKind,
    sourceId: src.sourceId,
    authorKind: src.author.kind,
    authorId: src.author.id,
  })));

  return mentioned;
}
