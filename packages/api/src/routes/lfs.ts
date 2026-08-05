import { Readable } from "node:stream";
import { Hono, type MiddlewareHandler } from "hono";
import { stream } from "hono/streaming";
import type { DB } from "../models/db.js";
import { authenticateGitRequestCached, callerFromGitAuth } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { AppError, AuthError, ValidationError } from "../services/errors.js";
import { assertValidOid, getObjectRow, LfsStore, markUploaded } from "../services/lfs.js";

// DoS guard: cap how much we buffer into memory for an LFS object PUT.
const MAX_UPLOAD = Number(process.env.CLAWHUB_MAX_UPLOAD_BYTES ?? 512 * 1024 * 1024);

// Mounted at root under /:ns/:repo.git/... — Git LFS client convention.
// See https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
export function createLfsRoutes(db: DB, lfsStore: LfsStore, publicBaseUrl: string): Hono {
  const app = new Hono();

  // Git LFS uses the same Basic-auth convention as git push (agent OR user
  // token). Authentication alone is NOT access: every handler authorizes the
  // resolved caller against the target repo via repo-access.ts (read for
  // download, write for upload) — otherwise any token could read/write any
  // repo's LFS blobs. Scoped to the LFS paths only — this router is mounted at
  // root, so a bare `use("*")` here would shadow the entire REST API.
  const requireGitAuth: MiddlewareHandler = async (c, next) => {
    const auth = await authenticateGitRequestCached(c);
    const caller = callerFromGitAuth(auth);
    if (!caller) throw new AuthError(auth.reason ?? "unauthenticated");
    c.set("tokenPayload", caller);
    await next();
  };
  app.use("/:ns/:repo{.+\\.git}/info/lfs/*", requireGitAuth);
  app.use("/:ns/:repo{.+\\.git}/lfs/*", requireGitAuth);

  app.post("/:ns/:repo{.+\\.git}/info/lfs/objects/batch", async c => {
    const ns = c.req.param("ns");
    const repoName = c.req.param("repo").replace(/\.git$/, "");
    const body = await c.req.json().catch(() => ({})) as {
      operation?: "download" | "upload";
      objects?: Array<{ oid: string; size: number }>;
    };
    if (!body.operation || !Array.isArray(body.objects)) throw new ValidationError("bad batch");
    // Every oid is echoed back into the `href` the client will PUT/GET, so an
    // unvalidated one here advertises a traversal URL as if it were legitimate.
    // Same predicate as the object routes — reject the whole batch.
    for (const o of body.objects) assertValidOid(o?.oid);
    // Authorize by intent: download needs read, upload needs write.
    const caller = c.get("tokenPayload");
    const { repo } = body.operation === "upload"
      ? await resolveRepoForWrite(db, ns, repoName, caller)
      : await resolveRepoForRead(db, ns, repoName, caller);

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
    // Validate the oid BEFORE touching the DB or disk: authorization decides
    // WHICH repo, but the oid decides which PATH inside it, and that answer is
    // client-supplied. Uniform 400 for every caller, so it leaks no repo state.
    const oid = assertValidOid(c.req.param("oid"));
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo").replace(/\.git$/, ""), c.get("tokenPayload"));
    // Reject oversized uploads by declared length before buffering anything into memory.
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_UPLOAD) throw new AppError("payload_too_large", "object too large", 413);
    const raw = await c.req.arrayBuffer();
    const buf = Buffer.from(raw);
    // Defense in depth: a missing/lying content-length still can't blow the cap.
    if (buf.length > MAX_UPLOAD) throw new AppError("payload_too_large", "object too large", 413);
    const { size, shaHex } = await lfsStore.writeObject(repo.id, oid, buf);
    if (shaHex !== oid) throw new ValidationError("oid_mismatch");
    await markUploaded(db, repo.id, oid, size);
    return c.json({ oid, size });
  });

  app.get("/:ns/:repo{.+\\.git}/lfs/objects/:oid", async c => {
    const oid = assertValidOid(c.req.param("oid"));
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo").replace(/\.git$/, ""), c.get("tokenPayload"));
    const opened = await lfsStore.openObject(repo.id, oid);
    if (!opened) return c.json({ error: "not_found" }, 404);
    c.header("content-type", "application/octet-stream");
    c.header("content-length", String(opened.size));
    return stream(c, async s => {
      // openObject hands back a Node Readable; Hono's stream helper pipes a WEB
      // ReadableStream (it calls `.pipeTo`). The cast used to paper over that
      // and every download died with "body.pipeTo is not a function" — adapt
      // instead of asserting.
      await s.pipe(Readable.toWeb(opened.stream as Readable) as ReadableStream);
    });
  });

  app.post("/:ns/:repo{.+\\.git}/lfs/objects/verify/:oid", async c => {
    const oid = assertValidOid(c.req.param("oid"));
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo").replace(/\.git$/, ""), c.get("tokenPayload"));
    const row = await getObjectRow(db, repo.id, oid);
    if (!row?.uploaded) return c.json({ error: "missing" }, 404);
    return c.json({ oid, size: row.size });
  });

  return app;
}
