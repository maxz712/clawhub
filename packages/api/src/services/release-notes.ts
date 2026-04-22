import { and, desc, eq, gt } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, releases } from "../models/schema.js";

export async function generateReleaseNotes(db: DB, repoId: string, opts: { sincePrevious?: boolean } = {}): Promise<string> {
  let sinceDate: Date | null = null;
  if (opts.sincePrevious) {
    const prev = (await db.select().from(releases).where(eq(releases.repoId, repoId)).orderBy(desc(releases.createdAt)).limit(1))[0];
    if (prev) sinceDate = prev.createdAt;
  }

  const where = sinceDate
    ? and(eq(changes.repoId, repoId), eq(changes.status, "merged"), gt(changes.mergedAt, sinceDate))
    : and(eq(changes.repoId, repoId), eq(changes.status, "merged"));

  const merged = await db.select().from(changes).where(where).orderBy(desc(changes.mergedAt)).limit(200);
  if (merged.length === 0) return "_No merged changes since the previous release._";

  const groups: Record<string, typeof merged> = { critical: [], high: [], medium: [], low: [] };
  for (const c of merged) groups[c.risk]?.push(c);

  const agentIds = Array.from(new Set(merged.map(c => c.openedByAgentId)));
  const agentLookup: Record<string, string> = {};
  for (const id of agentIds) {
    const a = (await db.select().from(agents).where(eq(agents.id, id)).limit(1))[0];
    if (a) agentLookup[id] = a.name;
  }

  const out: string[] = [];
  if (groups.critical.length) out.push("### Critical\n" + groups.critical.map(c => `- **${c.intent}** _by @${agentLookup[c.openedByAgentId] ?? "agent"}_`).join("\n"));
  if (groups.high.length) out.push("### High Risk\n" + groups.high.map(c => `- **${c.intent}** _by @${agentLookup[c.openedByAgentId] ?? "agent"}_`).join("\n"));
  if (groups.medium.length) out.push("### Medium Risk\n" + groups.medium.map(c => `- ${c.intent} _by @${agentLookup[c.openedByAgentId] ?? "agent"}_`).join("\n"));
  if (groups.low.length) out.push("### Fixes & Low Risk\n" + groups.low.map(c => `- ${c.intent} _by @${agentLookup[c.openedByAgentId] ?? "agent"}_`).join("\n"));

  out.push(`\n---\n_Generated from ${merged.length} merged change${merged.length === 1 ? "" : "s"} by ClawHub._`);
  return out.join("\n\n");
}
