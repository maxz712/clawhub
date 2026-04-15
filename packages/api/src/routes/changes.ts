import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes } from "../models/schema.js";
import type { GitService } from "../services/git.js";
import type { ChangeService } from "../services/changes.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { NotFoundError } from "../services/errors.js";
import { mergeFocus } from "../services/focus-parser.js";
import type { ReviewFocus } from "../services/trailer-parser.js";

export function createChangeRoutes(db: DB, git: GitService, changeSvc: ChangeService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/changes", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const rows = await db.select().from(changes).where(eq(changes.repoId, repo.id)).orderBy(desc(changes.updatedAt)).limit(100);
    return c.json({ changes: rows });
  });

  app.get("/:ns/:repo/changes/:id", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const decision = await changeSvc.evaluate(row.id);
    return c.json({ change: row, mergeable: decision });
  });

  app.get("/:ns/:repo/changes/:id/diff", async c => {
    const { namespace, repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const mode = (c.req.query("mode") ?? "focused") === "full" ? "full" : "focused";

    const raw = await git.diffRaw(namespace.name, repo.name, repo.defaultBranch, row.headCommit);
    if (mode === "full") return c.json({ mode, diff: raw });

    const focus = row.reviewFocus as ReviewFocus[];
    const focused = buildFocusedDiff(raw, focus);
    return c.json({ mode, diff: focused, focus });
  });

  app.post("/:ns/:repo/changes/:id/merge", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    await changeSvc.merge(row.id, p.kind === "user" ? { kind: "human", id: p.userId } : { kind: "agent", id: p.agentId });
    return c.json({ ok: true });
  });

  app.post("/:ns/:repo/changes/:id/rollback", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    await changeSvc.rollback(row.id);
    return c.json({ ok: true });
  });

  return app;
}

function buildFocusedDiff(rawDiff: string, focus: ReviewFocus[]): string {
  if (focus.length === 0) return "";
  const byPath = new Map<string, Array<{ start: number; end: number; note?: string }>>();
  for (const f of mergeFocus(focus)) {
    (byPath.get(f.path) ?? byPath.set(f.path, []).get(f.path)!).push({ start: f.startLine, end: f.endLine, note: f.note });
  }

  const out: string[] = [];
  const files = rawDiff.split(/(?=^diff --git )/m);
  for (const file of files) {
    const pathMatch = file.match(/^\+\+\+ b\/(.+)$/m);
    if (!pathMatch) continue;
    const ranges = byPath.get(pathMatch[1]);
    if (!ranges) continue;
    out.push(`### ${pathMatch[1]}`);
    const hunks = file.split(/(?=^@@ )/m);
    for (const h of hunks) {
      const hm = h.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!hm) continue;
      const start = Number(hm[1]);
      const length = hm[2] ? Number(hm[2]) : 1;
      const end = start + length - 1;
      if (ranges.some(r => !(r.end < start - 3 || r.start > end + 3))) out.push(h.trimEnd());
    }
  }
  return out.join("\n\n");
}
