import { eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, mentions, repositories, users } from "../models/schema.js";
import { repoAccessFor } from "./repo-access.js";
import type { TokenPayload } from "./auth.js";

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

  const resolved: Array<{ kind: "agent" | "human"; id: string; name: string }> = [];
  for (const a of agentRows) resolved.push({ kind: "agent", id: a.id, name: a.name });
  for (const u of userRows) if (u.username) resolved.push({ kind: "human", id: u.id, name: u.username });

  if (!resolved.length) return [];

  // Repo-access gate (#84): a mention MUST NOT reach an identity that can't see
  // the repo it occurred in. Repos default to private, so an unscoped mention
  // would leak a private Change/issue's existence (and a body snippet) into an
  // arbitrary user's inbox/email. Mirror #77 (assignee validation) by resolving
  // every target through repoAccessFor — the single authority for "may this
  // identity see this repo" — and dropping anyone below read access BEFORE the
  // mention row is recorded or delivered. When there's no repo context, there's
  // no private surface to protect, so no filtering applies.
  let mentioned = resolved;
  if (src.repoId) {
    const repo = (await db.select().from(repositories).where(eq(repositories.id, src.repoId)).limit(1))[0];
    if (!repo) return [];
    const allowed: typeof resolved = [];
    for (const m of resolved) {
      const caller: TokenPayload = m.kind === "agent"
        ? { kind: "agent", agentId: m.id, name: m.name }
        : { kind: "user", userId: m.id, email: "" };
      if ((await repoAccessFor(db, repo, caller)) !== "none") allowed.push(m);
    }
    mentioned = allowed;
  }

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
