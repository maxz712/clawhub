import { and, eq, max } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, issues, issueComments, repoCollaborators, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import { assertSafeRepoName, resolveImportOwner, sanitizeRepoName } from "./namespace.js";
import { recordImportedBranches } from "./import-common.js";
import { insertIssueWithNumber } from "./issue-number.js";
import { ValidationError } from "./errors.js";
import { assertPublicHttpHost, safeFetch } from "./url-guard.js";

const MAX_ISSUE_PAGES = 50;

export interface GitLabImportInput {
  gitlabToken: string;
  projectPath: string;          // e.g. "my-group/my-project"
  /** Owner namespace NAME to import into. Omitted → the agent's own service-user namespace. */
  targetNamespace?: string;
  namespaceId: string;          // the importing agent's id (resolves + authorizes the target)
  targetRepoName?: string;
  createdByKind: "agent" | "human" | "system";
  createdById: string;
  includeIssues?: boolean;
  includeComments?: boolean;
  host?: string;                // default gitlab.com
}

async function gl<T>(host: string, path: string, token: string): Promise<T> {
  // safeFetch: `host` is caller-supplied — pin the vetted IP, no redirect-follow.
  const res = await safeFetch(`https://${host}/api/v4${path}`, { headers: { "private-token": token } });
  if (!res.ok) throw new Error(`gitlab_${res.status}_${path}`);
  return (await res.json()) as T;
}

export async function importFromGitLab(db: DB, git: GitService, input: GitLabImportInput): Promise<{ repoId: string; repoName: string; namespace: string; cloned: boolean; branchesImported: number; issuesImported: number; commentsImported: number; issuesTruncated: boolean }> {
  // #138 service-level backstop — see importFromGitHub.
  if (input.targetRepoName !== undefined) assertSafeRepoName(input.targetRepoName, "targetRepoName");
  const host = input.host ?? "gitlab.com";
  // SSRF guard: the API host is caller-controlled — refuse a private/internal target before any fetch.
  const hostBlocked = await assertPublicHttpHost(`https://${host}`);
  if (hostBlocked) throw new ValidationError(`gitlab host rejected: ${hostBlocked}`);
  const pathParam = encodeURIComponent(input.projectPath);
  const project = await gl<{ description: string | null; default_branch: string; visibility: string; http_url_to_repo: string; name: string }>(host, `/projects/${pathParam}`, input.gitlabToken);

  // `project.name` is the upstream's DISPLAY name — untrusted, and free to carry
  // spaces or `..`. Sanitize rather than reject: the caller never typed it.
  const name = input.targetRepoName ?? sanitizeRepoName(project.name);
  // Agents never own — owned by the resolved + authorized owner namespace.
  const agent = (await db.select().from(agents).where(eq(agents.id, input.namespaceId)).limit(1))[0];
  if (!agent) throw new Error("import_agent_not_found");
  const owner = await resolveImportOwner(db, agent, input.targetNamespace);
  let repoRow = (await db.select().from(repositories).where(and(
    eq(repositories.namespaceType, owner.ownerKind), eq(repositories.namespaceId, owner.ownerId), eq(repositories.name, name),
  )).limit(1))[0];
  if (!repoRow) {
    const [row] = await db.insert(repositories).values({
      name,
      namespaceType: owner.ownerKind,
      namespaceId: owner.ownerId,
      description: project.description,
      defaultBranch: project.default_branch,
      isPublic: project.visibility === "public",
    }).returning();
    repoRow = row;
  }
  await db.insert(repoCollaborators).values({ repoId: repoRow.id, agentId: agent.id, role: "writer" }).onConflictDoNothing();

  // SSRF guard: the clone URL host is caller-controlled — validate before cloning (throw, don't swallow).
  const cloneBlocked = await assertPublicHttpHost(project.http_url_to_repo);
  if (cloneBlocked) throw new ValidationError(`gitlab clone url rejected: ${cloneBlocked}`);

  let cloned = false;
  let branchesImported = 0;
  try {
    const simpleGit = (await import("simple-git")).default;
    const { mkdir } = await import("node:fs/promises");
    const dest = git.pathOf(owner.diskNamespace, name);
    await mkdir(dest, { recursive: true });
    const url = project.http_url_to_repo.replace("https://", `https://oauth2:${input.gitlabToken}@`);
    // `--bare` (not `--mirror`) skips GitLab's refs/merge-requests/* clutter.
    // DoS guard: bound the clone so a malicious upstream can't hang/grow forever (disk quotas belong at the volume level).
    const cloneTimeoutMs = Number(process.env.CLAWHUB_IMPORT_CLONE_TIMEOUT_MS ?? 10 * 60 * 1000);
    await simpleGit({ timeout: { block: cloneTimeoutMs } }).clone(url, dest, ["--bare"]);
    cloned = true;
    branchesImported = await recordImportedBranches(db, git, repoRow.id, owner.diskNamespace, name);
  } catch { /* skip */ }

  let issuesImported = 0;
  let commentsImported = 0;
  let issuesTruncated = false;

  if (input.includeIssues !== false) {
    // Compute the starting issue number ONCE — a per-issue `MAX(number)` query
    // made an N-issue import N serial aggregate round-trips. The counter is a HINT
    // passed to the shared allocator (#119) — a concurrent create during the import window
    // falls back to a locked recompute instead of dying on `issues_repo_num_uniq`.
    const baseRow = await db.select({ m: max(issues.number) }).from(issues).where(eq(issues.repoId, repoRow.id));
    let nextNumber = (baseRow[0]?.m ?? 0) + 1;
    let page = 1;
    for (; page <= MAX_ISSUE_PAGES; page++) {
      const batch = await gl<Array<{ iid: number; title: string; description: string; state: string; labels: string[]; user_notes_count: number }>>(
        host, `/projects/${pathParam}/issues?per_page=100&page=${page}&scope=all`, input.gitlabToken,
      );
      if (!batch.length) break;
      for (const gi of batch) {
        const inserted = await insertIssueWithNumber(db, {
          repoId: repoRow.id,
          title: gi.title,
          body: gi.description ?? `_Imported from GitLab ${input.projectPath}#${gi.iid}_`,
          status: gi.state === "closed" ? "closed" : "open",
          labels: gi.labels,
          createdByKind: input.createdByKind,
          createdById: input.createdById,
        }, { numberHint: nextNumber });
        nextNumber = inserted.number + 1;
        issuesImported++;
        if (input.includeComments !== false && gi.user_notes_count > 0) {
          try {
            const notes = await gl<Array<{ body: string; author: { username: string } }>>(host, `/projects/${pathParam}/issues/${gi.iid}/notes`, input.gitlabToken);
            for (const n of notes) {
              await db.insert(issueComments).values({
                issueId: inserted.id,
                authorKind: "system",
                authorId: "00000000-0000-0000-0000-000000000000",
                body: `_@${n.author.username} (imported)_:\n\n${n.body}`,
              });
              commentsImported++;
            }
          } catch { /* skip */ }
        }
      }
      if (batch.length < 100) break;
      if (page === MAX_ISSUE_PAGES) issuesTruncated = true;
    }
  }

  return { repoId: repoRow.id, repoName: name, namespace: owner.diskNamespace, cloned, branchesImported, issuesImported, commentsImported, issuesTruncated };
}
