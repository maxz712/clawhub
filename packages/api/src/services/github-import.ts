import { eq, max } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { issues, issueComments, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";

export interface GitHubImportInput {
  githubToken: string;
  sourceOwner: string;
  sourceRepo: string;
  targetNamespace: string;  // agent namespace (clawhub)
  targetRepoName?: string;
  namespaceId: string;
  createdByKind: "agent" | "human" | "system";
  createdById: string;
  includeIssues?: boolean;
  includeComments?: boolean;
  ghHost?: string;         // default api.github.com — set for GHE
}

export interface ImportResult {
  repoId: string;
  repoName: string;
  cloned: boolean;
  issuesImported: number;
  commentsImported: number;
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

async function ghPaginate<T>(path: string, token: string, host = "api.github.com"): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page < 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh<T[]>(`${path}${sep}per_page=100&page=${page}`, token, host);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export async function importFromGitHub(db: DB, git: GitService, input: GitHubImportInput): Promise<ImportResult> {
  const host = input.ghHost ?? "api.github.com";
  const repoInfo = await gh<{ description: string | null; default_branch: string; private: boolean; language: string | null; clone_url: string }>(`/repos/${input.sourceOwner}/${input.sourceRepo}`, input.githubToken, host);

  const name = input.targetRepoName ?? input.sourceRepo;

  // Create repo row if absent.
  let repoRow = (await db.select().from(repositories).where(eq(repositories.name, name)).limit(1))[0];
  if (!repoRow) {
    const [row] = await db.insert(repositories).values({
      name,
      namespaceType: "agent",
      namespaceId: input.namespaceId,
      description: repoInfo.description,
      defaultBranch: repoInfo.default_branch,
      isPublic: !repoInfo.private,
      language: repoInfo.language,
    }).returning();
    repoRow = row;
  }

  // Clone git repo to disk (bare mirror).
  let cloned = false;
  try {
    const simpleGit = (await import("simple-git")).default;
    const destPath = git.pathOf(input.targetNamespace, name);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(destPath, { recursive: true });
    const authUrl = repoInfo.clone_url.replace("https://", `https://x-access-token:${input.githubToken}@`);
    await simpleGit().clone(authUrl, destPath, ["--mirror"]);
    cloned = true;
  } catch { /* already cloned or clone failed — continue with metadata import */ }

  let issuesImported = 0;
  let commentsImported = 0;

  if (input.includeIssues !== false) {
    const ghIssues = await ghPaginate<{ number: number; title: string; body: string | null; state: string; labels: Array<{ name: string }>; comments: number; pull_request?: unknown }>(
      `/repos/${input.sourceOwner}/${input.sourceRepo}/issues?state=all`, input.githubToken, host,
    );
    for (const gi of ghIssues.filter(i => !i.pull_request)) {
      const nextNumRow = await db.select({ m: max(issues.number) }).from(issues).where(eq(issues.repoId, repoRow.id));
      const number = (nextNumRow[0]?.m ?? 0) + 1;
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
          for (const gc of ghComments) {
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

  return { repoId: repoRow.id, repoName: name, cloned, issuesImported, commentsImported };
}
