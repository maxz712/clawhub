import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, branches, changes, issueComments, issues, issueChanges, milestones } from "../models/schema.js";
import type { GitService } from "../services/git.js";
import { optionalAuthMiddleware } from "../middleware/auth.js";
import { resolveRepoForPublicRead } from "../services/repo-access.js";
import { NotFoundError } from "../services/errors.js";
import { renderMarkdown } from "../services/docs-render.js";
import { splitRefPath } from "./code.js";
import type { ReviewFocus } from "../services/trailer-parser.js";
import type { TokenPayload } from "../services/auth.js";

const MAX_BLOB_BYTES = 512 * 1024;
const README_CANDIDATES = ["README.md", "readme.md", "Readme.md", "README"];

// Optional auth sets tokenPayload only when a valid token rides along; otherwise
// the caller is anonymous (null). resolveRepoForPublicRead admits public repos
// for anyone and private repos only for an authenticated member, 404ing the rest.
function callerOf(c: Context): TokenPayload | null {
  return (c.get("tokenPayload") ?? null) as TokenPayload | null;
}

async function serveTree(c: Context, git: GitService, ns: string, repo: string, ref: string, path: string) {
  const cleanPath = path.replace(/^\/+|\/+$/g, "");
  try {
    const entries = await git.listTree(ns, repo, ref, cleanPath);
    return c.json({ ref, path: cleanPath, entries });
  } catch {
    throw new NotFoundError(`tree ${ref}:${cleanPath}`);
  }
}

/**
 * Anonymous, read-only repo browsing for the logged-out public surface
 * (dashboard `/(public)/r/:ns/:repo/...`). Mirrors the authenticated
 * routes/code.ts + routes/changes.ts + routes/issues.ts read endpoints, but
 * gates every request through resolveRepoForPublicRead so PUBLIC repos serve to
 * anyone and PRIVATE repos 404 for a non-member (no existence leak). Mounted at
 * /api/v1/public/repos.
 */
export function createPublicRepoRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", optionalAuthMiddleware);

  // Repo metadata (mirrors GET /api/v1/repos/:ns/:repo, public-safe subset).
  app.get("/:ns/:repo", async c => {
    const { namespace, repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    return c.json({
      repo: {
        id: repo.id, name: repo.name, namespaceType: repo.namespaceType, namespaceId: repo.namespaceId,
        namespaceName: namespace.name, description: repo.description, defaultBranch: repo.defaultBranch,
        isPublic: repo.isPublic, forkOfRepoId: repo.forkOfRepoId, topics: repo.topics, language: repo.language,
        starsCount: repo.starsCount, watchersCount: repo.watchersCount, createdAt: repo.createdAt, updatedAt: repo.updatedAt,
      },
      namespace: { kind: namespace.kind, id: namespace.id, name: namespace.name },
    });
  });

  app.get("/:ns/:repo/branches", async c => {
    const { repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    const rows = await db.select().from(branches).where(eq(branches.repoId, repo.id));
    return c.json({
      branches: rows
        .map(b => ({ name: b.name, headCommit: b.headCommit, isDefault: b.name === repo.defaultBranch }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)),
    });
  });

  // Query-param tree form: /tree?ref=&path=
  app.get("/:ns/:repo/tree", async c => {
    const { namespace, repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    const path = (c.req.query("path") ?? "").replace(/^\/+|\/+$/g, "");
    return await serveTree(c, git, namespace.name, repo.name, ref, path);
  });

  // GitHub-style tree path form: /tree/<ref>/<path...> (slash-containing branch
  // names resolved greedily against the branch list, mirroring code.ts).
  app.get("/:ns/:repo/tree/:ref{.+}", async c => {
    const { namespace, repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    const slug = c.req.param("ref").replace(/\/+$/, "");
    const branchRows = await db.select({ name: branches.name }).from(branches).where(eq(branches.repoId, repo.id));
    const { ref, path } = splitRefPath(slug, branchRows.map(b => b.name));
    if (!ref) throw new NotFoundError("tree ref");
    return await serveTree(c, git, namespace.name, repo.name, ref, path);
  });

  app.get("/:ns/:repo/blob", async c => {
    const { namespace, repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    const path = (c.req.query("path") ?? "").replace(/^\/+/, "");
    if (!path) throw new NotFoundError("blob path");
    const content = await git.fileAt(namespace.name, repo.name, ref, path);
    if (content === null) throw new NotFoundError(`blob ${ref}:${path}`);
    const binary = content.includes("\0");
    const truncated = content.length > MAX_BLOB_BYTES;
    return c.json({ ref, path, size: content.length, binary, truncated, content: binary ? null : content.slice(0, MAX_BLOB_BYTES) });
  });

  app.get("/:ns/:repo/readme", async c => {
    const { namespace, repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    for (const name of README_CANDIDATES) {
      const content = await git.fileAt(namespace.name, repo.name, ref, name);
      if (content !== null) return c.json({ ref, name, html: renderMarkdown(content) });
    }
    return c.json({ ref, name: null, html: null });
  });

  app.get("/:ns/:repo/changes", async c => {
    const { repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    const rows = await db.select().from(changes).where(eq(changes.repoId, repo.id)).orderBy(desc(changes.updatedAt)).limit(100);
    return c.json({ changes: rows });
  });

  app.get("/:ns/:repo/changes/:id", async c => {
    const { repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const opener = (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.openedByAgentId)).limit(1))[0];
    const linkedIssues = await db.select({ number: issues.number, title: issues.title, status: issues.status })
      .from(issueChanges).innerJoin(issues, eq(issues.id, issueChanges.issueId))
      .where(eq(issueChanges.changeId, row.id)).orderBy(issues.number);
    return c.json({ change: row, openerName: opener?.name ?? null, linkedIssues });
  });

  app.get("/:ns/:repo/changes/:id/diff", async c => {
    const { namespace, repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const mode = (c.req.query("mode") ?? "focused") === "full" ? "full" : "focused";
    // Same diff-base selection as the authenticated route: a merged change diffs
    // against the merge commit's first parent so it doesn't go blank post-merge;
    // otherwise the merge-base gives a clean three-dot diff.
    let base: string;
    let target = row.headCommit;
    if (row.status === "merged" && row.mergeCommit && (row.mergeMethod === "merge" || row.mergeMethod === "squash")) {
      base = `${row.mergeCommit}^1`;
      target = row.mergeCommit;
    } else {
      base = (await git.mergeBase(namespace.name, repo.name, repo.defaultBranch, row.headCommit)) ?? repo.defaultBranch;
    }
    const raw = await git.diffRaw(namespace.name, repo.name, base, target);
    return c.json({ mode, diff: raw, focus: row.reviewFocus as ReviewFocus[] });
  });

  app.get("/:ns/:repo/issues", async c => {
    const { repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    const status = c.req.query("status");
    const conds = [eq(issues.repoId, repo.id)];
    if (status === "open" || status === "closed") conds.push(eq(issues.status, status));
    const rows = await db.select().from(issues).where(and(...conds)).orderBy(desc(issues.updatedAt)).limit(200);
    return c.json({ issues: rows });
  });

  app.get("/:ns/:repo/issues/:num", async c => {
    const { repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), callerOf(c));
    const number = Number(c.req.param("num"));
    const row = (await db.select().from(issues).where(and(eq(issues.repoId, repo.id), eq(issues.number, number))).limit(1))[0];
    if (!row) throw new NotFoundError("issue");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, row.id)).orderBy(asc(issueComments.createdAt));
    const milestone = row.milestoneId ? (await db.select().from(milestones).where(eq(milestones.id, row.milestoneId)).limit(1))[0] ?? null : null;
    const links = await db.select({ id: changes.id, branch: changes.branch, intent: changes.intent, status: changes.status })
      .from(issueChanges).innerJoin(changes, eq(changes.id, issueChanges.changeId))
      .where(eq(issueChanges.issueId, row.id)).orderBy(desc(issueChanges.createdAt));
    return c.json({ issue: row, comments, milestone, links });
  });

  return app;
}
