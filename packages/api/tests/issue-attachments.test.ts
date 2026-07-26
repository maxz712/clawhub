import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { repositories, users } from "../src/models/schema.js";
import { createIssueAttachmentRoutes } from "../src/routes/issue-attachments.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import type { ObjectStore } from "../src/services/object-store.js";

// Issue #12: issues/comments accept uploaded screenshots. The upload endpoint
// stores an image blob and returns a URL; the serve endpoint streams it back
// under repo-read auth. Real DB, in-memory object store.
process.env.JWT_SECRET ??= "test-secret-issue-attach";
const { signToken } = await import("../src/services/auth.js");

// Minimal in-memory ObjectStore so the test never touches disk/S3.
function memStore(): ObjectStore {
  const blobs = new Map<string, { body: Buffer; ct: string }>();
  return {
    async put(key, body, contentType) { blobs.set(key, { body, ct: contentType ?? "application/octet-stream" }); return { etag: "x", size: body.length }; },
    async get(key) {
      const b = blobs.get(key);
      if (!b) return null;
      async function* gen() { yield b!.body; }
      return { stream: gen() as unknown as NodeJS.ReadableStream, size: b.body.length, contentType: b.ct };
    },
  };
}

const S = Date.now();
let app: Hono;
let ns: string, repoName: string, auth: { headers: { authorization: string } };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

describe.skipIf(!hasTestDb)("issue attachments (#12)", () => {
  beforeAll(async () => {
    ns = `ia${S}`;
    repoName = `iarepo${S}`;
    const [u] = await db.insert(users).values({ email: `ia-${S}@t.co`, username: ns, passwordHash: "x" }).returning();
    await db.insert(repositories).values({ name: repoName, namespaceType: "user", namespaceId: u.id }).returning();
    auth = { headers: { authorization: `Bearer ${signToken({ kind: "user", userId: u.id, email: `ia-${S}@t.co` })}` } };

    app = new Hono();
    app.route("/api/v1/repos", createIssueAttachmentRoutes(db, memStore(), "http://api.test"));
    app.onError(errorHandler);
  });

  const upload = (body: Buffer, ct = "image/png") => app.request(`/api/v1/repos/${ns}/${repoName}/issue-attachments`, {
    method: "POST", headers: { ...auth.headers, "content-type": ct }, body,
  });

  it("uploads a PNG and returns a repo-scoped URL, then serves it back", async () => {
    const res = await upload(PNG);
    expect(res.status).toBe(201);
    const { url, blobId, contentType } = await res.json() as { url: string; blobId: string; contentType: string };
    expect(contentType).toBe("image/png");
    expect(blobId).toMatch(/^[a-f0-9-]{36}\.png$/);
    expect(url).toContain(`/api/v1/repos/${ns}/${repoName}/issue-attachments/${blobId}`);

    const get = await app.request(`/api/v1/repos/${ns}/${repoName}/issue-attachments/${blobId}`, { ...auth });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await get.arrayBuffer())).toEqual(PNG);
  });

  it("rejects a non-image content-type", async () => {
    const res = await upload(Buffer.from("hello"), "text/plain");
    expect(res.status).toBe(400);
    expect((await res.json() as { message?: string }).message).toMatch(/content-type/i);
  });

  it("rejects an empty body", async () => {
    const res = await upload(Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it("404s an unknown-but-well-formed blob id", async () => {
    const fake = "00000000-0000-0000-0000-000000000000.png";
    const res = await app.request(`/api/v1/repos/${ns}/${repoName}/issue-attachments/${fake}`, { ...auth });
    expect(res.status).toBe(404);
  });

  it("rejects a malformed blob id", async () => {
    const res = await app.request(`/api/v1/repos/${ns}/${repoName}/issue-attachments/..%2fsecret`, { ...auth });
    expect([400, 404]).toContain(res.status);
  });
});
