import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead } from "../services/repo-access.js";
import { ValidationError } from "../services/errors.js";
import type { ObjectStore } from "../services/object-store.js";

// Inline image attachments for issues + issue comments (#12). Markdown already
// renders `![](url)`, but a human filing a bug had nowhere to PUT a local
// screenshot — they had to host it elsewhere first. This is the object-store-
// backed blob behind an attachment URL: POST the PNG, get back a URL, drop it
// into the issue/comment body as `![name](url)`. Served through a read-authorized
// GET so a private repo's screenshots stay private.
//
// Repo READ gates both upload + serve — the same level `POST /issues` and the
// comment endpoint use, so anyone who can file/comment can attach, and nobody
// who can't see the repo can read its images.

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB — a screenshot, not an artifact
const CT_TO_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};
const EXT_TO_CT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};
// blobId is server-minted (uuid.ext) — pin the shape so a crafted id can't walk
// the object store outside this repo's prefix.
const BLOB_RE = /^[a-f0-9-]{36}\.[a-z0-9]{2,4}$/;

export function createIssueAttachmentRoutes(db: DB, store: ObjectStore, publicBaseUrl: string): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // Upload one image attachment for this repo's issues. Body is the raw bytes;
  // the content-type header selects the (image-only) kind.
  app.post("/:ns/:repo/issue-attachments", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));

    const ct = (c.req.header("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const ext = CT_TO_EXT[ct];
    if (!ext) throw new ValidationError(`unsupported attachment content-type: ${ct} (png/jpeg/webp/gif only)`);

    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length === 0) throw new ValidationError("empty body");
    if (buf.length > MAX_ATTACHMENT_BYTES) throw new ValidationError(`attachment too large (max ${MAX_ATTACHMENT_BYTES} bytes)`);

    const blobId = `${randomUUID()}.${ext}`;
    const key = `issue-attachments/${repo.id}/${blobId}`;
    await store.put(key, buf, ct);

    const ns = c.req.param("ns"), repoName = c.req.param("repo");
    const url = `${publicBaseUrl.replace(/\/+$/, "")}/api/v1/repos/${ns}/${repoName}/issue-attachments/${blobId}`;
    return c.json({ url, blobId, contentType: ct, size: buf.length }, 201);
  });

  // Serve an attachment. Read access to the repo is required, so a private repo's
  // screenshots are not world-readable.
  app.get("/:ns/:repo/issue-attachments/:blobId", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const blobId = c.req.param("blobId");
    if (!BLOB_RE.test(blobId)) throw new ValidationError("bad blob id");

    const key = `issue-attachments/${repo.id}/${blobId}`;
    const obj = await store.get(key);
    if (!obj) return c.json({ error: "not_found" }, 404);
    // Attachments are small (≤10MB) — buffer fully rather than stream so the
    // response terminates cleanly regardless of the store's stream flavor.
    const chunks: Buffer[] = [];
    for await (const ch of obj.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(ch));
    const body = Buffer.concat(chunks);
    const ext = blobId.split(".").pop()!;
    c.header("content-type", obj.contentType || EXT_TO_CT[ext] || "application/octet-stream");
    c.header("cache-control", "private, max-age=86400");
    return c.body(body);
  });

  return app;
}
