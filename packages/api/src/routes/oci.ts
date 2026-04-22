import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { DB } from "../models/db.js";
import { packageFiles, packages, packageVersions, repositories } from "../models/schema.js";
import { authenticateGitRequest } from "../middleware/auth.js";
import type { PackageStore } from "../services/packages.js";
import { mustResolveRepo } from "../services/repo-resolver.js";

// OCI distribution spec (https://github.com/opencontainers/distribution-spec)
// Minimal working server: /v2/, catalog, tags, manifest get/put, blob get/put
// via monolithic upload.
//
// The registry URL shape is /v2/<ns>/<repo>/<name>/... where <name> is the
// image name and the repo provides auth scope.

export function createOciRoutes(db: DB, store: PackageStore): Hono {
  const app = new Hono();

  // Basic-auth identical to git push. Anonymous GET allowed for public repos.
  app.use("/v2/*", async (c, next) => {
    const auth = authenticateGitRequest(c);
    if (auth.kind === "rejected") return c.json({ errors: [{ code: "DENIED", message: auth.reason }] }, 401, { "www-authenticate": 'Basic realm="clawhub-oci"' });
    await next();
  });

  app.get("/v2/", c => c.json({}, 200));

  // GET /v2/<ns>/<repo>/<name>/tags/list
  app.get("/v2/:ns/:repo/:name/tags/list", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const pkg = (await db.select().from(packages).where(and(eq(packages.repoId, repo.id), eq(packages.kind, "oci"), eq(packages.name, c.req.param("name")))).limit(1))[0];
    if (!pkg) return c.json({ errors: [{ code: "NAME_UNKNOWN" }] }, 404);
    const versions = await db.select().from(packageVersions).where(eq(packageVersions.packageId, pkg.id)).orderBy(desc(packageVersions.createdAt));
    return c.json({ name: `${c.req.param("ns")}/${c.req.param("repo")}/${c.req.param("name")}`, tags: versions.map(v => v.version) });
  });

  // GET /v2/.../manifests/<ref>
  app.get("/v2/:ns/:repo/:name/manifests/:ref", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const pkg = (await db.select().from(packages).where(and(eq(packages.repoId, repo.id), eq(packages.kind, "oci"), eq(packages.name, c.req.param("name")))).limit(1))[0];
    if (!pkg) return c.json({ errors: [{ code: "NAME_UNKNOWN" }] }, 404);
    const v = (await db.select().from(packageVersions).where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, c.req.param("ref")))).limit(1))[0];
    if (!v) return c.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, 404);
    const file = (await db.select().from(packageFiles).where(and(eq(packageFiles.versionId, v.id), eq(packageFiles.name, "manifest.json"))).limit(1))[0];
    if (!file) return c.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, 404);
    const opened = await store.openFile(file.path);
    if (!opened) return c.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, 404);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream as NodeJS.ReadableStream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
    const body = Buffer.concat(chunks);
    const digest = "sha256:" + createHash("sha256").update(body).digest("hex");
    c.header("docker-content-digest", digest);
    c.header("content-type", file.contentType || "application/vnd.oci.image.manifest.v1+json");
    return c.body(body, 200);
  });

  // PUT /v2/.../manifests/<ref>
  app.put("/v2/:ns/:repo/:name/manifests/:ref", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    let pkg = (await db.select().from(packages).where(and(eq(packages.repoId, repo.id), eq(packages.kind, "oci"), eq(packages.name, c.req.param("name")))).limit(1))[0];
    if (!pkg) [pkg] = await db.insert(packages).values({ repoId: repo.id, kind: "oci", name: c.req.param("name") }).returning();

    const body = Buffer.from(await c.req.arrayBuffer());
    const ct = c.req.header("content-type") ?? "application/vnd.oci.image.manifest.v1+json";
    let [v] = await db.insert(packageVersions).values({ packageId: pkg.id, version: c.req.param("ref"), metadata: {} }).onConflictDoNothing().returning();
    if (!v) v = (await db.select().from(packageVersions).where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, c.req.param("ref")))).limit(1))[0];
    const saved = await store.writeFile(repo.id, "oci", c.req.param("name"), c.req.param("ref"), "manifest.json", body);
    await db.insert(packageFiles).values({
      versionId: v!.id,
      name: "manifest.json",
      contentType: ct,
      size: saved.size,
      shasum: saved.shasum,
      path: saved.path,
    }).onConflictDoUpdate({ target: [packageFiles.versionId, packageFiles.name], set: { size: saved.size, shasum: saved.shasum, path: saved.path, contentType: ct } });

    const digest = "sha256:" + createHash("sha256").update(body).digest("hex");
    c.header("docker-content-digest", digest);
    c.header("location", `/v2/${c.req.param("ns")}/${c.req.param("repo")}/${c.req.param("name")}/manifests/${c.req.param("ref")}`);
    return c.body(null, 201);
  });

  // GET /v2/.../blobs/<digest>
  app.get("/v2/:ns/:repo/:name/blobs/:digest", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const pkg = (await db.select().from(packages).where(and(eq(packages.repoId, repo.id), eq(packages.kind, "oci"), eq(packages.name, c.req.param("name")))).limit(1))[0];
    if (!pkg) return c.json({ errors: [{ code: "BLOB_UNKNOWN" }] }, 404);
    // We store blobs as files named by digest under a synthetic version "_blobs".
    const v = (await db.select().from(packageVersions).where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, "_blobs"))).limit(1))[0];
    if (!v) return c.json({ errors: [{ code: "BLOB_UNKNOWN" }] }, 404);
    const file = (await db.select().from(packageFiles).where(and(eq(packageFiles.versionId, v.id), eq(packageFiles.name, c.req.param("digest")))).limit(1))[0];
    if (!file) return c.json({ errors: [{ code: "BLOB_UNKNOWN" }] }, 404);
    const opened = await store.openFile(file.path);
    if (!opened) return c.json({ errors: [{ code: "BLOB_UNKNOWN" }] }, 404);
    c.header("docker-content-digest", c.req.param("digest"));
    c.header("content-type", file.contentType);
    c.header("content-length", String(opened.size));
    const { stream } = await import("hono/streaming");
    return stream(c, async s => { await s.pipe(opened.stream as unknown as ReadableStream); });
  });

  // POST /v2/.../blobs/uploads/ — monolithic upload; we respond with a session URL.
  app.post("/v2/:ns/:repo/:name/blobs/uploads/", async c => {
    const session = randomUUID();
    const location = `/v2/${c.req.param("ns")}/${c.req.param("repo")}/${c.req.param("name")}/blobs/uploads/${session}`;
    c.header("location", location);
    c.header("range", "0-0");
    c.header("docker-upload-uuid", session);
    return c.body(null, 202);
  });

  // PUT /v2/.../blobs/uploads/:session?digest=sha256:...
  app.put("/v2/:ns/:repo/:name/blobs/uploads/:session", async c => {
    const digest = c.req.query("digest") ?? "";
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return c.json({ errors: [{ code: "DIGEST_INVALID" }] }, 400);
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    let pkg = (await db.select().from(packages).where(and(eq(packages.repoId, repo.id), eq(packages.kind, "oci"), eq(packages.name, c.req.param("name")))).limit(1))[0];
    if (!pkg) [pkg] = await db.insert(packages).values({ repoId: repo.id, kind: "oci", name: c.req.param("name") }).returning();

    const body = Buffer.from(await c.req.arrayBuffer());
    const computed = "sha256:" + createHash("sha256").update(body).digest("hex");
    if (computed !== digest) return c.json({ errors: [{ code: "DIGEST_INVALID" }] }, 400);

    let [v] = await db.insert(packageVersions).values({ packageId: pkg.id, version: "_blobs", metadata: {} }).onConflictDoNothing().returning();
    if (!v) v = (await db.select().from(packageVersions).where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, "_blobs"))).limit(1))[0];
    const saved = await store.writeFile(repo.id, "oci", c.req.param("name"), "_blobs", digest, body);
    await db.insert(packageFiles).values({
      versionId: v!.id, name: digest, contentType: c.req.header("content-type") ?? "application/octet-stream",
      size: saved.size, shasum: saved.shasum, path: saved.path,
    }).onConflictDoUpdate({ target: [packageFiles.versionId, packageFiles.name], set: { size: saved.size, shasum: saved.shasum, path: saved.path } });

    c.header("location", `/v2/${c.req.param("ns")}/${c.req.param("repo")}/${c.req.param("name")}/blobs/${digest}`);
    c.header("docker-content-digest", digest);
    return c.body(null, 201);
  });

  // GET /v2/_catalog
  app.get("/v2/_catalog", async c => {
    const repos = await db.select().from(repositories).limit(500);
    const names: string[] = [];
    for (const r of repos) {
      const pkgs = await db.select().from(packages).where(and(eq(packages.repoId, r.id), eq(packages.kind, "oci")));
      for (const p of pkgs) names.push(`${r.id}/${p.name}`); // opaque; clients hit tags/list to enumerate
    }
    return c.json({ repositories: names });
  });

  return app;
}
