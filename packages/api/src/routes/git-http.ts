import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, branches, repositories } from "../models/schema.js";
import type { GitService } from "../services/git.js";
import type { ChangeRefService } from "../services/change-refs.js";
import type { EventBus } from "../services/events.js";
import { authenticateGitRequest } from "../middleware/auth.js";
import { proxyToGitBackend } from "../services/git-backend.js";
import { ensureRepoForAgentPush } from "../services/auto-repo.js";
import { processPush } from "../services/post-push.js";
import { resolveNamespace } from "../services/repo-resolver.js";

/**
 * Git Smart HTTP. Routes:
 *   GET    /:ns/:repo.git/info/refs?service=...
 *   POST   /:ns/:repo.git/git-upload-pack      (fetch)
 *   POST   /:ns/:repo.git/git-receive-pack     (push — agents only)
 */
export function createGitHttpRoutes(
  db: DB,
  git: GitService,
  changeRefs: ChangeRefService,
  events: EventBus,
): Hono {
  const app = new Hono();

  app.all("/:ns/:repo{.+\\.git}/*", async c => {
    const namespace = c.req.param("ns");
    const repoParam = c.req.param("repo");
    const repoName = repoParam.replace(/\.git$/, "");
    const url = new URL(c.req.url);
    const pathSuffix = url.pathname.split(`${repoParam}/`)[1] ?? "";

    const isPush = pathSuffix === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
    const auth = authenticateGitRequest(c);

    if (auth.kind === "rejected") {
      return c.json({ error: auth.reason }, 403);
    }

    // Read before push: allow anonymous for public repos.
    let agentId: string | undefined = auth.kind === "agent" ? auth.agentId : undefined;

    if (isPush) {
      if (auth.kind !== "agent" || !auth.agentId) {
        return new Response("agent authentication required (only agents commit)", {
          status: 401,
          headers: { "www-authenticate": "Basic realm=\"clawhub-git\"" },
        });
      }
      await ensureRepoForAgentPush(db, git, namespace, repoName, auth.agentId);
    } else {
      // Fetch/pull: require repo to exist; check visibility.
      const ns = await resolveNamespace(db, namespace);
      if (!ns) return c.json({ error: "not_found" }, 404);
      const repo = (await db.select().from(repositories).where(and(
        eq(repositories.namespaceType, ns.kind),
        eq(repositories.namespaceId, ns.id),
        eq(repositories.name, repoName),
      )).limit(1))[0];
      if (!repo) return c.json({ error: "not_found" }, 404);
      if (!repo.isPublic && auth.kind !== "agent") {
        return new Response("authentication required", { status: 401, headers: { "www-authenticate": "Basic realm=\"clawhub-git\"" } });
      }
    }

    // Snapshot branch heads before the push so we can compute diffs after.
    let priorHeads: Record<string, string> = {};
    if (isPush) {
      const ns = await resolveNamespace(db, namespace);
      if (ns) {
        const repo = (await db.select().from(repositories).where(and(
          eq(repositories.namespaceType, ns.kind),
          eq(repositories.namespaceId, ns.id),
          eq(repositories.name, repoName),
        )).limit(1))[0];
        if (repo) {
          const bs = await db.select().from(branches).where(eq(branches.repoId, repo.id));
          for (const b of bs) priorHeads[b.name] = b.headCommit;
        }
      }
    }

    // Proxy the raw request to git http-backend.
    const res = await proxyToGitBackend(c, git, namespace, repoName, pathSuffix);

    // After a successful push, detect updated branches and run the post-push pipeline.
    if (isPush && res.status >= 200 && res.status < 400) {
      setImmediate(() => { void runPostPush(db, git, changeRefs, events, namespace, repoName, agentId!, priorHeads); });
    }

    return res;
  });

  return app;
}

async function runPostPush(
  db: DB,
  git: GitService,
  changeRefs: ChangeRefService,
  events: EventBus,
  namespace: string,
  repoName: string,
  agentId: string,
  priorHeads: Record<string, string>,
): Promise<void> {
  try {
    const ns = await resolveNamespace(db, namespace);
    if (!ns) return;
    const repo = (await db.select().from(repositories).where(and(
      eq(repositories.namespaceType, ns.kind),
      eq(repositories.namespaceId, ns.id),
      eq(repositories.name, repoName),
    )).limit(1))[0];
    if (!repo) return;

    // Discover current branch heads via git.
    const current: Record<string, string> = {};
    try {
      const out = await git.open(namespace, repoName).raw(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"]);
      for (const line of out.split("\n").map(s => s.trim()).filter(Boolean)) {
        const [name, sha] = line.split(/\s+/);
        current[name] = sha;
      }
    } catch { return; }

    const pushedRefs = [] as Array<{ ref: string; oldSha: string; newSha: string }>;
    for (const [name, sha] of Object.entries(current)) {
      if (priorHeads[name] !== sha) {
        pushedRefs.push({ ref: `refs/heads/${name}`, oldSha: priorHeads[name] ?? "0".repeat(40), newSha: sha });
      }
    }
    for (const name of Object.keys(priorHeads)) {
      if (!(name in current)) {
        pushedRefs.push({ ref: `refs/heads/${name}`, oldSha: priorHeads[name], newSha: "0".repeat(40) });
      }
    }

    if (!pushedRefs.length) return;
    await processPush({
      db, git, changeRefs, events,
      namespace, repoName, repoId: repo.id,
      defaultBranch: repo.defaultBranch, agentId, pushedRefs,
    });
  } catch (e) {
    console.error("[post-push]", (e as Error).message);
  }
}
