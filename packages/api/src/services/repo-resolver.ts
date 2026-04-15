import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, organizations, repositories } from "../models/schema.js";
import { NotFoundError } from "./errors.js";

export interface ResolvedNamespace {
  kind: "agent" | "org";
  id: string;
  name: string;
}

export async function resolveNamespace(db: DB, name: string): Promise<ResolvedNamespace | null> {
  const agent = await db.select().from(agents).where(eq(agents.name, name)).limit(1);
  if (agent[0]) return { kind: "agent", id: agent[0].id, name: agent[0].name };
  const org = await db.select().from(organizations).where(eq(organizations.name, name)).limit(1);
  if (org[0]) return { kind: "org", id: org[0].id, name: org[0].name };
  return null;
}

export async function resolveRepo(db: DB, namespace: string, repoName: string) {
  const ns = await resolveNamespace(db, namespace);
  if (!ns) return null;
  const repo = await db.select().from(repositories).where(and(
    eq(repositories.namespaceType, ns.kind),
    eq(repositories.namespaceId, ns.id),
    eq(repositories.name, repoName),
  )).limit(1);
  if (!repo[0]) return null;
  return { namespace: ns, repo: repo[0] };
}

export async function mustResolveRepo(db: DB, namespace: string, repoName: string) {
  const r = await resolveRepo(db, namespace, repoName);
  if (!r) throw new NotFoundError(`repo ${namespace}/${repoName}`);
  return r;
}
