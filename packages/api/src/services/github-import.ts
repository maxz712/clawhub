import { and, eq, max } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, issues, issueComments, repoCollaborators, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import { resolveImportOwner } from "./namespace.js";
import { recordImportedBranches } from "./import-common.js";
import { ValidationError } from "./errors.js";
import { assertPublicHttpHost } from "./url-guard.js";

// Issue pagination cap: at most this many pages of 100 are imported. A repo with
// more issues than the cap is truncated — `issuesTruncated` flags it so the
// caller can warn the user instead of silently dropping the rest.
const MAX_ISSUE_PAGES = 50;

export interface GitHubImportInput {
  githubToken: string;
  sourceOwner: string;
  sourceRepo: string;
  /** Owner namespace NAME to import into. Omitted → the agent's own service-user namespace. */
  targetNamespace?: string;
  targetRepoName?: string;
  namespaceId: string;     // the importing agent's id (resolves + authorizes the target)
  createdByKind: "agent" | "human" | "system";
  createdById: string;
  includeIssues?: boolean;
  includeComments?: boolean;
  ghHost?: string;         // default api.github.com — set for GHE
}

export interface ImportResult {
  repoId: string;
  repoName: string;
  /** The owner namespace NAME the repo landed under (for linking to it). */
  namespace: string;
  cloned: boolean;
  branchesImported: number;
  issuesImported: number;
  commentsImported: number;
  /** True when the source had more issues than the import cap (some were skipped). */
  issuesTruncated: boolean;
}

async function gh<T>(path: string, token: string, host = "api.github.com"): Promise<T> {
  const res = await fetch(`https://${host}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`github_${res.status}_${path}`);
  return (await res.json()) as T;
}

async function ghPaginate<T>(path: string, token: string, host = "api.github.com", maxPages = MAX_ISSUE_PAGES): Promise<{ items: T[]; truncated: boolean }> {
  const all: T[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh<T[]>(`${path}${sep}per_page=100&page=${page}`, token, host);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    // A full final page means there's very likely more we didn't fetch.
    if (page === maxPages) truncated = true;
  }
  return { items: all, truncated };
}

export async function importFromGitHub(db: DB, git: GitService, input: GitHubImportInput): Promise<ImportResult> {
  const host = input.ghHost ?? "api.github.com";
  // SSRF guard: the API host is caller-controlled — refuse a private/internal target before any fetch.
  const hostBlocked = await assertPublicHttpHost(`https://${host}`);
  if (hostBlocked) throw new ValidationError(`github host rejected: ${hostBlocked}`);
  const repoInfo = await gh<{ description: string | null; default_branch: string; private: boolean; language: string | null; clone_url: string }>(`/repos/${input.sourceOwner}/${input.sourceRepo}`, input.githubToken, host);

  const name = input.targetRepoName ?? input.sourceRepo;

  // Agents never own — the imported repo is owned by a USER or ORG namespace the
  // agent is authorized to create in (its own service-account by default), and
  // the agent is granted writer. resolveImportOwner is the create gate.
  const agent = (await db.select().from(agents).where(eq(agents.id, input.namespaceId)).limit(1))[0];
  if (!agent) throw new Error("import_agent_not_found");
  const owner = await resolveImportOwner(db, agent, input.targetNamespace);

  // Create repo row if absent (owned by the resolved namespace).
  let repoRow = (await db.select().from(repositories).where(and(
    eq(repositories.namespaceType, owner.ownerKind), eq(repositories.namespaceId, owner.ownerId), eq(repositories.name, name),
  )).limit(1))[0];
  if (!repoRow) {
    const [row] = await db.insert(repositories).values({
      name,
      namespaceType: owner.ownerKind,
      namespaceId: owner.ownerId,
      description: repoInfo.description,
      defaultBranch: repoInfo.default_branch,
      isPublic: !repoInfo.private,
      language: repoInfo.language,
    }).returning();
    repoRow = row;
  }
  await db.insert(repoCollaborators).values({ repoId: repoRow.id, agentId: agent.id, role: "writer" }).onConflictDoNothing();

  // Clone git repo to disk under the owner namespace. `--bare` (not `--mirror`)
  // copies the source's branch heads to refs/heads/* + tags but skips GitHub's
  // refs/pull/* (a --mirror would drag in thousands of PR refs as clutter).
  // SSRF guard: the clone_url host is caller-controlled — validate before cloning (throw, don't swallow).
  const cloneBlocked = await assertPublicHttpHost(repoInfo.clone_url);
  if (cloneBlocked) throw new ValidationError(`github clone url rejected: ${cloneBlocked}`);

  let cloned = false;
  let branchesImported = 0;
  try {
    const simpleGit = (await import("simple-git")).default;
    const destPath = git.pathOf(owner.diskNamespace, name);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(destPath, { recursive: true });
    const authUrl = repoInfo.clone_url.replace("https://", `https://x-access-token:${input.githubToken}@`);
    await simpleGit().clone(authUrl, destPath, ["--bare"]);
    cloned = true;
    // Seed the branches table so the code browser shows the imported code
    // instead of "No code yet" (the dashboard lists branches from the DB).
    branchesImported = await recordImportedBranches(db, git, repoRow.id, owner.diskNamespace, name);
  } catch { /* already cloned or clone failed — continue with metadata import */ }

  let issuesImported = 0;
  let commentsImported = 0;
  let issuesTruncated = false;

  if (input.includeIssues !== false) {
    const page = await ghPaginate<{ number: number; title: string; body: string | null; state: string; labels: Array<{ name: string }>; comments: number; pull_request?: unknown }>(
      `/repos/${input.sourceOwner}/${input.sourceRepo}/issues?state=all`, input.githubToken, host,
    );
    issuesTruncated = page.truncated;
    // Compute the starting issue number ONCE — a per-issue `MAX(number)` query
    // turned an N-issue import into N serial aggregate round-trips. Imports run
    // single-threaded per job, so a local counter is the authoritative source.
    const baseRow = await db.select({ m: max(issues.number) }).from(issues).where(eq(issues.repoId, repoRow.id));
    let nextNumber = (baseRow[0]?.m ?? 0) + 1;
    for (const gi of page.items.filter(i => !i.pull_request)) {
      const number = nextNumber++;
      const [inserted] = await db.insert(issues).values({
        repoId: repoRow.id,
        number,
        title: gi.title,
        body: gi.body ?? `_Imported from GitHub: ${input.sourceOwner}/${input.sourceRepo}#${gi.number}_`,
        status: gi.state === "closed" ? "closed" : "open",
        labels: (gi.labels ?? []).map(l => l.name),
        createdByKind: input.createdByKind,
        createdById: input.createdById,
      }).returning();
      issuesImported++;

      if (input.includeComments !== false && gi.comments > 0) {
        try {
          const ghComments = await ghPaginate<{ body: string; user: { login: string } }>(`/repos/${input.sourceOwner}/${input.sourceRepo}/issues/${gi.number}/comments`, input.githubToken, host);
          for (const gc of ghComments.items) {
            await db.insert(issueComments).values({
              issueId: inserted.id,
              authorKind: "system",
              authorId: "00000000-0000-0000-0000-000000000000",
              body: `_@${gc.user.login} (imported)_:\n\n${gc.body}`,
            });
            commentsImported++;
          }
        } catch { /* skip comment failures */ }
      }
    }
  }

  return { repoId: repoRow.id, repoName: name, namespace: owner.diskNamespace, cloned, branchesImported, issuesImported, commentsImported, issuesTruncated };
}
