import { eq, max } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { issues, issueComments, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";

export interface GitLabImportInput {
  gitlabToken: string;
  projectPath: string;          // e.g. "my-group/my-project"
  targetNamespace: string;
  namespaceId: string;
  targetRepoName?: string;
  createdByKind: "agent" | "human" | "system";
  createdById: string;
  includeIssues?: boolean;
  includeComments?: boolean;
  host?: string;                // default gitlab.com
}

async function gl<T>(host: string, path: string, token: string): Promise<T> {
  const res = await fetch(`https://${host}/api/v4${path}`, { headers: { "private-token": token } });
  if (!res.ok) throw new Error(`gitlab_${res.status}_${path}`);
  return (await res.json()) as T;
}

export async function importFromGitLab(db: DB, git: GitService, input: GitLabImportInput): Promise<{ repoId: string; repoName: string; cloned: boolean; issuesImported: number; commentsImported: number }> {
  const host = input.host ?? "gitlab.com";
  const pathParam = encodeURIComponent(input.projectPath);
  const project = await gl<{ description: string | null; default_branch: string; visibility: string; http_url_to_repo: string; name: string }>(host, `/projects/${pathParam}`, input.gitlabToken);

  const name = input.targetRepoName ?? project.name;
  let repoRow = (await db.select().from(repositories).where(eq(repositories.name, name)).limit(1))[0];
  if (!repoRow) {
    const [row] = await db.insert(repositories).values({
      name,
      namespaceType: "agent",
      namespaceId: input.namespaceId,
      description: project.description,
      defaultBranch: project.default_branch,
      isPublic: project.visibility === "public",
    }).returning();
    repoRow = row;
  }

  let cloned = false;
  try {
    const simpleGit = (await import("simple-git")).default;
    const { mkdir } = await import("node:fs/promises");
    const dest = git.pathOf(input.targetNamespace, name);
    await mkdir(dest, { recursive: true });
    const url = project.http_url_to_repo.replace("https://", `https://oauth2:${input.gitlabToken}@`);
    await simpleGit().clone(url, dest, ["--mirror"]);
    cloned = true;
  } catch { /* skip */ }

  let issuesImported = 0;
  let commentsImported = 0;

  if (input.includeIssues !== false) {
    let page = 1;
    for (; page < 50; page++) {
      const batch = await gl<Array<{ iid: number; title: string; description: string; state: string; labels: string[]; user_notes_count: number }>>(
        host, `/projects/${pathParam}/issues?per_page=100&page=${page}&scope=all`, input.gitlabToken,
      );
      if (!batch.length) break;
      for (const gi of batch) {
        const nextNumRow = await db.select({ m: max(issues.number) }).from(issues).where(eq(issues.repoId, repoRow.id));
        const number = (nextNumRow[0]?.m ?? 0) + 1;
        const [inserted] = await db.insert(issues).values({
          repoId: repoRow.id,
          number,
          title: gi.title,
          body: gi.description ?? `_Imported from GitLab ${input.projectPath}#${gi.iid}_`,
          status: gi.state === "closed" ? "closed" : "open",
          labels: gi.labels,
          createdByKind: input.createdByKind,
          createdById: input.createdById,
        }).returning();
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
    }
  }

  return { repoId: repoRow.id, repoName: name, cloned, issuesImported, commentsImported };
}
