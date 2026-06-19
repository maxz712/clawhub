import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { repositories } from "../models/schema.js";
import { NotFoundError } from "./errors.js";
import { resolveNamespace } from "./namespace.js";

// Re-exported so the ~30 callers that import from this module keep working.
export { resolveNamespace } from "./namespace.js";
export type { ResolvedNamespace, NamespaceKind } from "./namespace.js";

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
