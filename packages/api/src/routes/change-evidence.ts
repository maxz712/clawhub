import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForReview } from "../services/repo-access.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import type { ObjectStore } from "../services/object-store.js";

// Inline binary evidence (screenshots, log captures) attached to a Change. An
// agent that builds a UI, drives a browser, and screenshots what it built needs
// somewhere to PUT the PNG and get back a URL it can hang off a review as
// `evidence[].url`. Reviews only store a URL pointer (routes/reviews.ts); this is
// the object-store-backed blob behind that URL, served through a read-authorized
// GET so a private repo's screenshots stay private.
//
// Flow: agent pushes (opens the Change) → POST the PNG here → gets a URL →
// POST a `comment` review with `evidence:[{kind:"screenshot", url}]`.

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024; // 16 MB — a screenshot, not a release artifact
const CT_TO_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "text/plain": "txt", "application/json": "json",
};
const EXT_TO_CT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  txt: "text/plain; charset=utf-8", json: "application/json",
};
// blobId is server-minted (uuid.ext) — pin the shape so a crafted id can't walk
// the object store outside this change's prefix.
const BLOB_RE = /^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/;

async function loadChange(db: DB, repoId: string, id: string) {
  const change = (await db.select().from(changes).where(and(eq(changes.id, id), eq(changes.repoId, repoId))).limit(1))[0];
  if (!change) throw new NotFoundError("change");
  return change;
}

export function createChangeEvidenceRoutes(db: DB, store: ObjectStore, publicBaseUrl: string): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // Upload one evidence blob for a change. Body is the raw bytes; content-type
  // header selects the kind. Gated at REVIEW level so any reviewer/writer agent
  // (or a human) who could attach the evidence to a review can also store it.
  app.post("/:ns/:repo/changes/:id/evidence", async c => {
    const { repo } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const change = await loadChange(db, repo.id, c.req.param("id"));

    const ct = (c.req.header("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const ext = CT_TO_EXT[ct];
    if (!ext) throw new ValidationError(`unsupported evidence content-type: ${ct} (png/jpeg/webp/gif/txt/json)`);

    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length === 0) throw new ValidationError("empty body");
    if (buf.length > MAX_EVIDENCE_BYTES) throw new ValidationError(`evidence too large (max ${MAX_EVIDENCE_BYTES} bytes)`);

    const blobId = `${randomUUID()}.${ext}`;
    const key = `evidence/${repo.id}/${change.id}/${blobId}`;
    await store.put(key, buf, ct);

    const ns = c.req.param("ns"), repoName = c.req.param("repo");
    const url = `${publicBaseUrl.replace(/\/+$/, "")}/api/v1/repos/${ns}/${repoName}/changes/${change.id}/evidence/${blobId}`;
    return c.json({ url, blobId, contentType: ct, size: buf.length }, 201);
  });

  // Serve an evidence blob. Read access to the repo is required, so a private
  // repo's screenshots are not world-readable.
  app.get("/:ns/:repo/changes/:id/evidence/:blobId", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await loadChange(db, repo.id, c.req.param("id"));
    const blobId = c.req.param("blobId");
    if (!BLOB_RE.test(blobId)) throw new ValidationError("bad blob id");

    const key = `evidence/${repo.id}/${c.req.param("id")}/${blobId}`;
    const obj = await store.get(key);
    if (!obj) return c.json({ error: "not_found" }, 404);
    // Evidence blobs are small (≤16MB) — buffer fully rather than stream so the
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
