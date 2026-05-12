import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { branches, repositories } from "../models/schema.js";
import type { GitService } from "../services/git.js";
import type { ChangeRefService } from "../services/change-refs.js";
import type { EventBus } from "../services/events.js";
import { authenticateGitRequestCached } from "../middleware/auth.js";
import { proxyToGitBackend } from "../services/git-backend.js";
import { ensureRepoForAgentPush } from "../services/auto-repo.js";
import { resolveNamespace } from "../services/repo-resolver.js";
import type { PushQueue } from "../services/push-queue.js";
import { runPostPushJob } from "../services/post-push-runner.js";

/**
 * Git Smart HTTP. Routes:
 *   GET    /:ns/:repo.git/info/refs?service=...
 *   POST   /:ns/:repo.git/git-upload-pack      (fetch)
 *   POST   /:ns/:repo.git/git-receive-pack     (push — agents only)
 *
 * Push handling:
 *   - Auth uses the Redis-backed JWT cache so verify cost amortizes.
 *   - Branch snapshot taken before proxying to `git http-backend`.
 *   - On 2xx/3xx, a {@link PushJob} is enqueued onto the durable push queue.
 *     The worker drains the heavy post-push work (trailers, secret scan,
 *     SAST, code-index) off the request thread. If Redis is unavailable the
 *     queue runs the job via its in-process fallback so we never lose pushes.
 */
export function createGitHttpRoutes(
  db: DB,
  git: GitService,
  changeRefs: ChangeRefService,
  events: EventBus,
  queue: PushQueue,
): Hono {
  const app = new Hono();

  // Register a Redis-down fallback so pushes never silently drop their post-push work.
  queue.onFallback(job => runPostPushJob({ db, git, changeRefs, events }, job));

  app.all("/:ns/:repo{.+\\.git}/*", async c => {
    const namespace = c.req.param("ns");
    const repoParam = c.req.param("repo");
    const repoName = repoParam.replace(/\.git$/, "");
    const url = new URL(c.req.url);
    const pathSuffix = url.pathname.split(`${repoParam}/`)[1] ?? "";

    const isPush = pathSuffix === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
    const auth = await authenticateGitRequestCached(c);

    if (auth.kind === "rejected") {
      return c.json({ error: auth.reason }, 403);
    }

    if (isPush) {
      if (auth.kind !== "agent" || !auth.agentId) {
        return new Response("agent authentication required (only agents commit)", {
          status: 401,
          headers: { "www-authenticate": "Basic realm=\"clawhub-git\"" },
        });
      }
      await ensureRepoForAgentPush(db, git, namespace, repoName, auth.agentId);
    } else {
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

    // Snapshot branch heads before the push so the worker can compute diffs.
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

    const res = await proxyToGitBackend(c, git, namespace, repoName, pathSuffix);

    if (isPush && auth.kind === "agent" && auth.agentId && res.status >= 200 && res.status < 400) {
      const ns = await resolveNamespace(db, namespace);
      if (ns) {
        const repo = (await db.select().from(repositories).where(and(
          eq(repositories.namespaceType, ns.kind),
          eq(repositories.namespaceId, ns.id),
          eq(repositories.name, repoName),
        )).limit(1))[0];
        if (repo) {
          // Fire-and-forget enqueue: don't make the agent wait on Redis.
          void queue.enqueue({
            namespace, repoName, repoId: repo.id,
            defaultBranch: repo.defaultBranch,
            agentId: auth.agentId,
            priorHeads,
            receivedAt: new Date().toISOString(),
            mode: "direct",
          });
        }
      }
    }

    return res;
  });

  return app;
}
