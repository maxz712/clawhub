import { eq, max } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { issues, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";

export interface BitbucketImportInput {
  workspace: string;
  repoSlug: string;
  username: string;       // bitbucket username
  appPassword: string;    // bitbucket app password
  targetNamespace: string;
  namespaceId: string;
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

  let repoRow = (await db.select().from(repositories).where(eq(repositories.name, name)).limit(1))[0];
  if (!repoRow) {
    [repoRow] = await db.insert(repositories).values({
      name, namespaceType: "agent", namespaceId: input.namespaceId,
      description: info.description, defaultBranch: info.mainbranch?.name ?? "main",
      isPublic: !info.is_private,
    }).returning();
  }

  let cloned = false;
  if (cloneHref) {
    try {
      const simpleGit = (await import("simple-git")).default;
      const { mkdir } = await import("node:fs/promises");
      const dest = git.pathOf(input.targetNamespace, name);
      await mkdir(dest, { recursive: true });
      const authedUrl = cloneHref.replace("https://", `https://${input.username}:${input.appPassword}@`);
      await simpleGit().clone(authedUrl, dest, ["--mirror"]);
      cloned = true;
    } catch { /* skip */ }
  }

  let issuesImported = 0;
  if (input.includeIssues !== false) {
    try {
      let page = 1;
      while (page < 50) {
        const batch = await bb<{ values?: Array<{ id: number; title: string; content?: { raw?: string }; state: string }> }>(
          input.workspace, input.repoSlug, `/issues?page=${page}&pagelen=50`, input.username, input.appPassword,
        );
        if (!batch.values?.length) break;
        for (const bi of batch.values) {
          const nextNumRow = await db.select({ m: max(issues.number) }).from(issues).where(eq(issues.repoId, repoRow.id));
          const number = (nextNumRow[0]?.m ?? 0) + 1;
          await db.insert(issues).values({
            repoId: repoRow.id,
            number,
            title: bi.title,
            body: bi.content?.raw ?? `_Imported from Bitbucket ${input.workspace}/${input.repoSlug}#${bi.id}_`,
            status: bi.state === "resolved" || bi.state === "closed" ? "closed" : "open",
            labels: [],
            createdByKind: input.createdByKind,
            createdById: input.createdById,
          });
          issuesImported++;
        }
        if (batch.values.length < 50) break;
        page++;
      }
    } catch { /* skip */ }
  }

  return { repoId: repoRow.id, repoName: name, cloned, issuesImported };
}
