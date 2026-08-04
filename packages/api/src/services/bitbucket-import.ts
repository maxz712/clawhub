import { and, eq, max } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, issues, repoCollaborators, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import { resolveImportOwner } from "./namespace.js";
import { recordImportedBranches } from "./import-common.js";
import { insertIssueWithNumber } from "./issue-number.js";
import { ValidationError } from "./errors.js";
import { assertPublicHttpHost } from "./url-guard.js";

const MAX_ISSUE_PAGES = 50;

export interface BitbucketImportInput {
  workspace: string;
  repoSlug: string;
  username: string;       // bitbucket username
  appPassword: string;    // bitbucket app password
  /** Owner namespace NAME to import into. Omitted → the agent's own service-user namespace. */
  targetNamespace?: string;
  namespaceId: string;    // the importing agent's id (resolves + authorizes the target)
  targetRepoName?: string;
  createdByKind: "agent" | "human" | "system";
  createdById: string;
  includeIssues?: boolean;
}

async function bb<T>(workspace: string, slug: string, path: string, username: string, pass: string): Promise<T> {
  const auth = Buffer.from(`${username}:${pass}`).toString("base64");
  const url = `https://api.bitbucket.org/2.0/repositories/${workspace}/${slug}${path}`;
  const res = await fetch(url, { headers: { authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`bitbucket_${res.status}_${path}`);
  return (await res.json()) as T;
}

export async function importFromBitbucket(db: DB, git: GitService, input: BitbucketImportInput) {
  const info = await bb<{ description: string; mainbranch: { name: string }; is_private: boolean; links: { clone: Array<{ name: string; href: string }> } }>(
    input.workspace, input.repoSlug, "", input.username, input.appPassword,
  );
  const name = input.targetRepoName ?? input.repoSlug;
  const cloneHref = info.links.clone.find(c => c.name === "https")?.href ?? "";

  // Agents never own — owned by the resolved + authorized owner namespace.
  const agent = (await db.select().from(agents).where(eq(agents.id, input.namespaceId)).limit(1))[0];
  if (!agent) throw new Error("import_agent_not_found");
  const owner = await resolveImportOwner(db, agent, input.targetNamespace);

  let repoRow = (await db.select().from(repositories).where(and(
    eq(repositories.namespaceType, owner.ownerKind), eq(repositories.namespaceId, owner.ownerId), eq(repositories.name, name),
  )).limit(1))[0];
  if (!repoRow) {
    [repoRow] = await db.insert(repositories).values({
      name, namespaceType: owner.ownerKind, namespaceId: owner.ownerId,
      description: info.description, defaultBranch: info.mainbranch?.name ?? "main",
      isPublic: !info.is_private,
    }).returning();
  }
  await db.insert(repoCollaborators).values({ repoId: repoRow.id, agentId: agent.id, role: "writer" }).onConflictDoNothing();

  let cloned = false;
  let branchesImported = 0;
  if (cloneHref) {
    // SSRF guard: the clone href host is caller-influenced — validate before cloning (throw, don't swallow).
    const cloneBlocked = await assertPublicHttpHost(cloneHref);
    if (cloneBlocked) throw new ValidationError(`bitbucket clone url rejected: ${cloneBlocked}`);
    try {
      const simpleGit = (await import("simple-git")).default;
      const { mkdir } = await import("node:fs/promises");
      const dest = git.pathOf(owner.diskNamespace, name);
      await mkdir(dest, { recursive: true });
      const authedUrl = cloneHref.replace("https://", `https://${input.username}:${input.appPassword}@`);
      // DoS guard: bound the clone so a malicious upstream can't hang/grow forever (disk quotas belong at the volume level).
      const cloneTimeoutMs = Number(process.env.CLAWHUB_IMPORT_CLONE_TIMEOUT_MS ?? 10 * 60 * 1000);
      await simpleGit({ timeout: { block: cloneTimeoutMs } }).clone(authedUrl, dest, ["--bare"]);
      cloned = true;
      branchesImported = await recordImportedBranches(db, git, repoRow.id, owner.diskNamespace, name);
    } catch { /* skip */ }
  }

  let issuesImported = 0;
  let issuesTruncated = false;
  if (input.includeIssues !== false) {
    try {
      // Compute the starting issue number ONCE — a per-issue `MAX(number)` query
      // made an N-issue import N serial aggregate round-trips. The counter is a HINT
      // passed to the shared allocator (#119) — a concurrent create during the import window
      // falls back to a locked recompute instead of dying on `issues_repo_num_uniq`.
      const baseRow = await db.select({ m: max(issues.number) }).from(issues).where(eq(issues.repoId, repoRow.id));
      let nextNumber = (baseRow[0]?.m ?? 0) + 1;
      let page = 1;
      while (page <= MAX_ISSUE_PAGES) {
        const batch = await bb<{ values?: Array<{ id: number; title: string; content?: { raw?: string }; state: string }> }>(
          input.workspace, input.repoSlug, `/issues?page=${page}&pagelen=50`, input.username, input.appPassword,
        );
        if (!batch.values?.length) break;
        for (const bi of batch.values) {
          const inserted = await insertIssueWithNumber(db, {
            repoId: repoRow.id,
            title: bi.title,
            body: bi.content?.raw ?? `_Imported from Bitbucket ${input.workspace}/${input.repoSlug}#${bi.id}_`,
            status: bi.state === "resolved" || bi.state === "closed" ? "closed" : "open",
            labels: [],
            createdByKind: input.createdByKind,
            createdById: input.createdById,
          }, { numberHint: nextNumber });
          nextNumber = inserted.number + 1;
          issuesImported++;
        }
        if (batch.values.length < 50) break;
        if (page === MAX_ISSUE_PAGES) issuesTruncated = true;
        page++;
      }
    } catch { /* skip */ }
  }

  return { repoId: repoRow.id, repoName: name, namespace: owner.diskNamespace, cloned, branchesImported, issuesImported, issuesTruncated };
}
