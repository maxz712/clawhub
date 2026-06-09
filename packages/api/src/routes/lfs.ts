import { Hono, type MiddlewareHandler } from "hono";
import { stream } from "hono/streaming";
import type { DB } from "../models/db.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { authenticateGitRequest } from "../middleware/auth.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { getObjectRow, LfsStore, markUploaded } from "../services/lfs.js";

// Mounted at root under /:ns/:repo.git/... — Git LFS client convention.
// See https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
export function createLfsRoutes(db: DB, lfsStore: LfsStore, publicBaseUrl: string): Hono {
  const app = new Hono();

  // Git LFS uses the same Basic-auth convention as git push; require an agent token.
  // Scoped to the LFS paths only — this router is mounted at root, so a bare
  // `use("*")` here would shadow the entire REST API.
  const requireAgent: MiddlewareHandler = async (c, next) => {
    const auth = authenticateGitRequest(c);
    if (auth.kind !== "agent") throw new AuthError(auth.reason ?? "unauthenticated");
    c.set("lfsAgentId", auth.agentId!);
    await next();
  };
  app.use("/:ns/:repo{.+\\.git}/info/lfs/*", requireAgent);
  app.use("/:ns/:repo{.+\\.git}/lfs/*", requireAgent);

  app.post("/:ns/:repo{.+\\.git}/info/lfs/objects/batch", async c => {
    const ns = c.req.param("ns");
    const repoName = c.req.param("repo").replace(/\.git$/, "");
    const { repo } = await mustResolveRepo(db, ns, repoName);
    const body = await c.req.json().catch(() => ({})) as {
      operation?: "download" | "upload";
      objects?: Array<{ oid: string; size: number }>;
    };
    if (!body.operation || !Array.isArray(body.objects)) throw new ValidationError("bad batch");

    const base = `${publicBaseUrl.replace(/\/+$/, "")}/${ns}/${repoName}.git/lfs/objects`;

    const objects = [] as Array<Record<string, unknown>>;
    for (const o of body.objects) {
      const row = await getObjectRow(db, repo.id, o.oid);
      if (body.operation === "download") {
        if (row?.uploaded) {
          objects.push({ oid: o.oid, size: o.size, actions: { download: { href: `${base}/${o.oid}` } } });
        } else {
          objects.push({ oid: o.oid, size: o.size, error: { code: 404, message: "not_found" } });
        }
      } else {
        // upload: tell the client where to PUT
        objects.push({ oid: o.oid, size: o.size, actions: { upload: { href: `${base}/${o.oid}` }, verify: { href: `${base}/verify/${o.oid}` } } });
      }
    }
    return c.json({ transfer: "basic", objects });
  });

  app.put("/:ns/:repo{.+\\.git}/lfs/objects/:oid", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo").replace(/\.git$/, ""));
    const oid = c.req.param("oid");
    const raw = await c.req.arrayBuffer();
    const buf = Buffer.from(raw);
    const { size, shaHex } = await lfsStore.writeObject(repo.id, oid, buf);
    if (shaHex !== oid) throw new ValidationError("oid_mismatch");
    await markUploaded(db, repo.id, oid, size);
    return c.json({ oid, size });
  });

  app.get("/:ns/:repo{.+\\.git}/lfs/objects/:oid", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo").replace(/\.git$/, ""));
    const oid = c.req.param("oid");
    const opened = await lfsStore.openObject(repo.id, oid);
    if (!opened) return c.json({ error: "not_found" }, 404);
    c.header("content-type", "application/octet-stream");
    c.header("content-length", String(opened.size));
    return stream(c, async s => {
      await s.pipe(opened.stream as unknown as ReadableStream);
    });
  });

  app.post("/:ns/:repo{.+\\.git}/lfs/objects/verify/:oid", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo").replace(/\.git$/, ""));
    const oid = c.req.param("oid");
    const row = await getObjectRow(db, repo.id, oid);
    if (!row?.uploaded) return c.json({ error: "missing" }, 404);
    return c.json({ oid, size: row.size });
  });

  return app;
}

declare module "hono" {
  interface ContextVariableMap {
    lfsAgentId: string;
  }
}
