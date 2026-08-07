import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { repositories } from "../models/schema.js";
import type { GitService } from "../services/git.js";
import { authMiddleware } from "../middleware/auth.js";
import { visibleRepoIds } from "../services/repo-access.js";
import { search, countStats } from "../services/search.js";

export function createSearchRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  // Search was mounted with NO auth and returned every tenant's PRIVATE
  // repos/issues/changes/code to anyone. Authenticate every caller, then scope
  // repo-bound results to what the caller may actually see.
  app.use("*", authMiddleware);

  app.get("/", async c => {
    const p = c.get("tokenPayload");
    const q = c.req.query("q") ?? "";
    // `public=1` keeps the prior public-directory behavior (public repos only),
    // additionally intersected with the caller's visible set below — it can only
    // narrow, never widen, what a caller sees.
    const publicOnly = c.req.query("public") === "1";
    const limit = Number(c.req.query("limit") ?? 20);
    // Compute visibility FIRST so code search can grep the caller's repos (not
    // just repos whose name matched the query — that missed code in every
    // freshly-pushed repo). Results are still re-filtered by `allowed()` below.
    const visible = await visibleRepoIds(db, p);
    const out = await search(db, git, q, { publicOnly, limit, codeRepoIds: [...visible] });

    // The search service queries issues/changes/agents GLOBALLY (not joined to
    // the repo results), so a returned issue/change may belong to a repo the
    // caller cannot see. Gate every repo-bound result: keep it only when the repo
    // is in the caller's visible set OR is itself public. A private repo (and its
    // issues/changes/code) the caller doesn't govern is dropped — no cross-tenant
    // leak. Resolve public-ness for EVERY referenced repo id (across repos +
    // issues + changes + code) in one query, not just the repos page.
    const referenced = new Set<string>([
      ...out.repos.map(r => r.id),
      ...out.issues.map(i => i.repoId),
      ...out.changes.map(ch => ch.repoId),
      ...out.code.map(cd => cd.repoId),
    ]);
    const publicRepoIds = new Set<string>();
    if (referenced.size) {
      const flags = await db.select({ id: repositories.id, isPublic: repositories.isPublic }).from(repositories).where(inArray(repositories.id, [...referenced]));
      for (const r of flags) if (r.isPublic) publicRepoIds.add(r.id);
    }
    const allowed = (repoId: string) => visible.has(repoId) || publicRepoIds.has(repoId);

    return c.json({
      repos: out.repos.filter(r => allowed(r.id)),
      issues: out.issues.filter(i => allowed(i.repoId)),
      changes: out.changes.filter(ch => allowed(ch.repoId)),
      // Agent names are a public directory (leaderboard/marketplace) — not repo-private.
      agents: out.agents,
      code: out.code.filter(cd => allowed(cd.repoId)),
    });
  });

  app.get("/stats", async c => {
    // Platform-wide aggregate counts only (no per-tenant rows). Authenticated to
    // match the rest of this router; also exposed unauth via /api/v1/public.
    const s = await countStats(db);
    return c.json(s);
  });

  return app;
}
