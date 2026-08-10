import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { branches, repositories } from "../models/schema.js";
import type { GitService } from "../services/git.js";
import type { ChangeRefService } from "../services/change-refs.js";
import type { EventBus } from "../services/events.js";
import { authenticateGitRequestCached } from "../middleware/auth.js";
import { proxyToGitBackend } from "../services/git-backend.js";
import { ensureRepoForAgentPush, ensureRepoForUserPush } from "../services/auto-repo.js";
import { isAgentKilled } from "../services/kill-switch.js";
import { resolveNamespace } from "../services/repo-resolver.js";
import { accessAtLeast, repoAccessFor } from "../services/repo-access.js";
import { callerFromGitAuth } from "../middleware/auth.js";
import { isSafePathSegment } from "../services/namespace.js";
import type { PushQueue, PushActor } from "../services/push-queue.js";
import { runPostPushJob } from "../services/post-push-runner.js";
import { isLocal, ShardMap } from "../services/shard-map.js";
import { GitClientPool } from "../services/git-client.js";
import type { ShardHealthMonitor } from "../services/shard-health.js";
import { metrics } from "../services/metrics.js";
import type { Context } from "hono";

/**
 * Public-facing origin for this request. Honors a reverse proxy's
 * `x-forwarded-proto`/`x-forwarded-host` (production runs behind Caddy) and an
 * explicit `CLAWHUB_PUBLIC_URL` override; falls back to the raw request URL.
 * Used to make error hints (e.g. the git-push rejection) self-documenting with
 * absolute URLs an agent can act on.
 */
function requestOrigin(c: Context, url: URL): string {
  const configured = process.env.CLAWHUB_PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const proto = (c.req.header("x-forwarded-proto") ?? url.protocol.replace(/:$/, "")).split(",")[0].trim();
  const host = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host).split(",")[0].trim();
  return `${proto}://${host}`;
}

/**
 * Git Smart HTTP. Routes:
 *   GET    /:ns/:repo.git/info/refs?service=...
 *   POST   /:ns/:repo.git/git-upload-pack      (fetch)
 *   POST   /:ns/:repo.git/git-receive-pack     (push — agents only)
 *
 * Routing:
 *   - Resolve the repo's primary shard via {@link ShardMap}.
 *   - If `local`: serve in-process via `git http-backend` (the default in dev
 *     and small deployments).
 *   - Otherwise: forward to the shard via {@link GitClientPool}. The shard's
 *     HTTP surface accepts the same Smart HTTP paths and proxies internally.
 *     A circuit breaker (see {@link ShardHealthMonitor}) short-circuits
 *     requests to known-unhealthy shards with a 503.
 *
 * Post-push:
 *   - Snapshot branch heads before the request.
 *   - On 2xx/3xx, enqueue a {@link PushJob}. The worker drains trailer
 *     parsing, secret scan, SAST, code-index, etc.
 *   - If the queue is unreachable, the in-process fallback runs the job.
 */
export interface GitHttpRouteDeps {
  db: DB;
  git: GitService;
  changeRefs: ChangeRefService;
  events: EventBus;
  queue: PushQueue;
  shardMap: ShardMap;
  gitClients: GitClientPool;
  shardHealth?: ShardHealthMonitor;
}

export function createGitHttpRoutes(deps: GitHttpRouteDeps): Hono;
// Legacy signature (kept for backward compatibility with older callers).
export function createGitHttpRoutes(
  db: DB,
  git: GitService,
  changeRefs: ChangeRefService,
  events: EventBus,
  queue: PushQueue,
): Hono;
export function createGitHttpRoutes(...args: unknown[]): Hono {
  const deps = normalizeArgs(args);
  return build(deps);
}

function normalizeArgs(args: unknown[]): GitHttpRouteDeps {
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null && "db" in (args[0] as object)) {
    return args[0] as GitHttpRouteDeps;
  }
  const [db, git, changeRefs, events, queue] = args as [DB, GitService, ChangeRefService, EventBus, PushQueue];
  return {
    db, git, changeRefs, events, queue,
    shardMap: new ShardMap(db),
    gitClients: new GitClientPool(),
  };
}

function build(deps: GitHttpRouteDeps): Hono {
  const { db, git, changeRefs, events, queue, shardMap, gitClients, shardHealth } = deps;
  const app = new Hono();

  queue.onFallback(job => runPostPushJob({ db, git, changeRefs, events }, job));

  app.all("/:ns/:repo{.+\\.git}/*", async c => {
    const namespace = c.req.param("ns");
    const repoParam = c.req.param("repo");
    const repoName = repoParam.replace(/\.git$/, "");
    // Reject path-traversal in the namespace/repo before they reach pathOf
    // (path.resolve) or auto-repo. `:repo` can carry decoded slashes/`..`.
    if (!isSafePathSegment(namespace) || !isSafePathSegment(repoName)) {
      return c.json({ error: "invalid_repo_path" }, 400);
    }
    const url = new URL(c.req.url);
    const pathSuffix = url.pathname.split(`${repoParam}/`)[1] ?? "";

    const isPush = pathSuffix === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
    const auth = await authenticateGitRequestCached(c);
    // Set by the fetch branch below, which must resolve the repo row anyway to
    // authorize the caller against it.
    let fetchRepoRow: typeof repositories.$inferSelect | null = null;

    if (auth.kind === "rejected") {
      // Make the rejection self-documenting so a caller (agent harness or a human
      // with a stale token) pointed at just the host URL can bootstrap itself:
      // how to authenticate, where to register, where the skill lives.
      const origin = requestOrigin(c, url);
      const hint = `Authenticate git with HTTP Basic: password = a JWT. Humans push with their USER token (run 'ch login' then 'ch init', or use any username + your user token). Agents push with an AGENT token (username 'agent-token'). Register an agent: POST ${origin}/api/v1/agents. Onboarding skill: ${origin}/skill.md`;
      return c.json({ error: auth.reason, hint }, 403);
    }

    if (isPush) {
      if (auth.kind === "agent" && auth.agentId) {
        // Kill switch is enforced at the push boundary, BEFORE proxying to git
        // http-backend — so a killed agent's commits never land on disk (we do
        // not rely on the post-push check, which runs after the pack applies).
        // The token-cache revocation checker also denies a killed agent's token,
        // but this is the hard pre-write guarantee within the cache TTL.
        if (await isAgentKilled(db, auth.agentId)) {
          return new Response("agent killed", {
            status: 403,
            headers: { "content-type": "text/plain" },
          });
        }
        await ensureRepoForAgentPush(db, git, namespace, repoName, auth.agentId, { shardMap, gitClients });
      } else if (auth.kind === "user" && auth.userId) {
        // Human push: a logged-in person committing their own code. Repo
        // ownership + write access is decided by ensureRepoForUserPush (which
        // defers to repoAccessFor). No kill switch — that governs agents only.
        try {
          await ensureRepoForUserPush(db, git, namespace, repoName, auth.userId, { shardMap, gitClients });
        } catch (e) {
          const status = (e as { status?: number }).status ?? 403;
          return new Response((e as Error).message ?? "push not permitted", { status, headers: { "content-type": "text/plain" } });
        }
      } else {
        return new Response("authentication required to push", {
          status: 401,
          headers: { "www-authenticate": "Basic realm=\"clawhub-git\"" },
        });
      }
    } else {
      // FETCH (clone / ls-remote / fetch, plus the dumb-HTTP object paths).
      // Authentication is NOT access (#146): this used to ask "is the caller
      // anonymous?" and stop there, while every sibling read surface — REST
      // browse, LFS, OCI — authorizes the resolved caller through
      // repo-access.ts. Repos are private by DEFAULT, so any token minted by a
      // free self-serve signup cloned every private repo on the instance with
      // full history, gh-mirror shadow repos of third-party GitHub PRs
      // included. The gate runs HERE so it covers both fetch entry points
      // (`info/refs?service=git-upload-pack` and `POST git-upload-pack`) and
      // precedes both the local backend proxy and shard forwarding below.
      const ns = await resolveNamespace(db, namespace);
      if (!ns) return c.json({ error: "not_found" }, 404);
      const repo = (await db.select().from(repositories).where(and(
        eq(repositories.namespaceType, ns.kind),
        eq(repositories.namespaceId, ns.id),
        eq(repositories.name, repoName),
      )).limit(1))[0];
      if (!repo) return c.json({ error: "not_found" }, 404);
      fetchRepoRow = repo;
      const caller = callerFromGitAuth(auth); // null === anonymous
      // repoAccessFor(_, _, null) already returns "read" for a PUBLIC repo, so
      // logged-out clones and CI keep working unchanged.
      if (!accessAtLeast(await repoAccessFor(db, repo, caller), "read")) {
        metrics.inc("clawhub_git_fetch_denied_total", { reason: caller ? "no_access" : "anonymous" });
        // Git probes unauthenticated first and only sends credentials after a
        // challenge, so the two denials must differ. ANONYMOUS → 401 +
        // WWW-Authenticate, so `git clone` of a private repo you legitimately
        // own prompts for credentials instead of hard-failing. AUTHENTICATED
        // but unauthorized → 404 (not 403), matching requireRepoRead, so a
        // private repo's existence is never leaked.
        if (!caller) {
          return new Response("authentication required", { status: 401, headers: { "www-authenticate": "Basic realm=\"clawhub-git\"" } });
        }
        return c.json({ error: "not_found" }, 404);
      }
    }

    // Lookup placement once; reused below. The fetch branch already resolved
    // the row to authorize against it — don't pay for the same query twice.
    const repoRow = fetchRepoRow ?? await lookupRepoRow(db, namespace, repoName);

    let priorHeads: Record<string, string> = {};
    if (isPush && repoRow) {
      const bs = await db.select().from(branches).where(eq(branches.repoId, repoRow.id));
      for (const b of bs) priorHeads[b.name] = b.headCommit;
    }

    let res: Response;
    if (repoRow) {
      const shard = await shardMap.primaryFor(repoRow.id);
      if (isLocal(shard)) {
        res = await proxyToGitBackend(c, git, namespace, repoName, pathSuffix);
      } else {
        // Circuit breaker: refuse fast when the shard is known-down.
        if (shardHealth && !shardHealth.canRequest(shard.id)) {
          metrics.inc("clawhub_shard_request_total", { shard: shard.id, op: pathSuffix, status: "circuit_open" });
          return new Response("shard temporarily unavailable", { status: 503, headers: { "retry-after": "5" } });
        }
        const client = gitClients.get(shard);
        try {
          const upstream = await client.forwardGitHttp({
            namespace, name: repoName, pathSuffix,
            method: c.req.method,
            query: url.search.replace(/^\?/, ""),
            contentType: c.req.header("content-type") ?? undefined,
            body: c.req.raw.body,
          });
          if (shardHealth) shardHealth.reportResult(shard.id, upstream.status < 500);
          metrics.inc("clawhub_shard_request_total", { shard: shard.id, op: pathSuffix, status: String(upstream.status) });
          res = new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
        } catch (e) {
          if (shardHealth) shardHealth.reportResult(shard.id, false);
          metrics.inc("clawhub_shard_request_total", { shard: shard.id, op: pathSuffix, status: "error" });
          return new Response(`shard_forward_failed: ${(e as Error).message}`, { status: 502 });
        }
      }
    } else {
      // No DB row yet — fall through to local backend (auto-repo created it above).
      res = await proxyToGitBackend(c, git, namespace, repoName, pathSuffix);
    }

    const pushActor: PushActor | null =
      auth.kind === "agent" && auth.agentId ? { kind: "agent", agentId: auth.agentId }
      : auth.kind === "user" && auth.userId ? { kind: "user", userId: auth.userId }
      : null;
    const isReceivePackPost = pathSuffix === "git-receive-pack" && c.req.method === "POST";
    if (isReceivePackPost && pushActor && res.status >= 200 && res.status < 400 && repoRow) {
      // git http-backend (and remote shards) update refs while the response
      // body streams. Buffer the status report — it is tiny — so the push job
      // is enqueued only after the refs are actually on disk; otherwise the
      // worker can race the pack apply, see no new refs, and drop the job.
      const report = await res.arrayBuffer();
      res = new Response(report, { status: res.status, headers: res.headers });
      void queue.enqueue({
        namespace, repoName, repoId: repoRow.id,
        defaultBranch: repoRow.defaultBranch,
        actor: pushActor,
        // Legacy mirror so an older worker draining the stream still attributes
        // agent pushes; new workers read `actor`.
        agentId: pushActor.kind === "agent" ? pushActor.agentId : undefined,
        priorHeads,
        receivedAt: new Date().toISOString(),
        mode: "direct",
      });
    }

    return res;
  });

  return app;
}

async function lookupRepoRow(db: DB, namespace: string, repoName: string) {
  const ns = await resolveNamespace(db, namespace);
  if (!ns) return null;
  return (await db.select().from(repositories).where(and(
    eq(repositories.namespaceType, ns.kind),
    eq(repositories.namespaceId, ns.id),
    eq(repositories.name, repoName),
  )).limit(1))[0] ?? null;
}
