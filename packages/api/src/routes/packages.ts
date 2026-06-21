import { Hono } from "hono";
import { stream } from "hono/streaming";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { packageFiles, packages, packageVersions } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { getFile, listVersions, PackageStore, publish } from "../services/packages.js";

// Generic registry: publish / list / download under the repo.
export function createPackageRoutes(db: DB, store: PackageStore, publicBaseUrl: string): { auth: Hono; pub: Hono } {
  const auth = new Hono();
  auth.use("*", authMiddleware);

  auth.get("/:ns/:repo/packages", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(packages).where(eq(packages.repoId, repo.id)).orderBy(desc(packages.createdAt));
    return c.json({ packages: rows });
  });

  auth.get("/:ns/:repo/packages/:kind/:name/versions", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const kind = c.req.param("kind") as "generic" | "npm" | "oci" | "maven" | "pypi";
    const { versions } = await listVersions(db, repo.id, kind, decodeURIComponent(c.req.param("name")));
    return c.json({ versions });
  });

  auth.post("/:ns/:repo/packages/:kind/:name/versions/:version/files/:filename", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const kind = c.req.param("kind") as "generic" | "npm" | "oci" | "maven" | "pypi";
    const name = decodeURIComponent(c.req.param("name"));
    const version = decodeURIComponent(c.req.param("version"));
    const filename = decodeURIComponent(c.req.param("filename"));
    const body = Buffer.from(await c.req.arrayBuffer());
    const metadataHeader = c.req.header("x-package-metadata");
    const metadata = metadataHeader ? safeJson(metadataHeader) : undefined;
    const result = await publish(db, store, { repoId: repo.id, kind, name, version, metadata, files: [{ filename, contentType: c.req.header("content-type") ?? undefined, body }] });
    return c.json(result, 201);
  });

  auth.delete("/:ns/:repo/packages/:kind/:name/versions/:version", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const kind = c.req.param("kind") as "generic" | "npm" | "oci" | "maven" | "pypi";
    const name = decodeURIComponent(c.req.param("name"));
    const pkg = (await db.select().from(packages).where(and(eq(packages.repoId, repo.id), eq(packages.kind, kind), eq(packages.name, name))).limit(1))[0];
    if (!pkg) throw new NotFoundError("package");
    await db.delete(packageVersions).where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, decodeURIComponent(c.req.param("version")))));
    return c.json({ ok: true });
  });

  // Public download (anyone can read published packages in public repos).
  const pub = new Hono();
  pub.get("/:ns/:repo/packages/:kind/:name/versions/:version/files/:filename", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    if (!repo.isPublic) return c.json({ error: "private_repo" }, 403);
    const file = await getFile(db, repo.id, c.req.param("kind") as "generic", decodeURIComponent(c.req.param("name")), decodeURIComponent(c.req.param("version")), decodeURIComponent(c.req.param("filename")));
    if (!file) return c.json({ error: "not_found" }, 404);
    const opened = await store.openFile(file.path);
    if (!opened) return c.json({ error: "gone" }, 410);
    c.header("content-type", file.contentType);
    c.header("content-length", String(opened.size));
    c.header("x-shasum-sha512", file.shasum ?? "");
    return stream(c, async s => { await s.pipe(opened.stream as unknown as ReadableStream); });
  });

  // npm-compatible registry: mount under /:ns/:repo/-/npm/...
  // Supports: GET package metadata, GET tarball, PUT publish.
  auth.get("/:ns/:repo/-/npm/:pkg", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const name = decodeURIComponent(c.req.param("pkg"));
    const pkg = (await db.select().from(packages).where(and(eq(packages.repoId, repo.id), eq(packages.kind, "npm"), eq(packages.name, name))).limit(1))[0];
    if (!pkg) return c.json({ error: "not_found" }, 404);
    const versions = await db.select().from(packageVersions).where(eq(packageVersions.packageId, pkg.id));
    const files = await db.select().from(packageFiles).where(eq(packageFiles.versionId, versions[0]?.id ?? ""));
    const base = `${publicBaseUrl.replace(/\/+$/, "")}/api/v1/repos/${c.req.param("ns")}/${c.req.param("repo")}`;
    const out: Record<string, unknown> = {
      name,
      "dist-tags": { latest: versions.at(-1)?.version ?? "0.0.0" },
      versions: Object.fromEntries(versions.map(v => {
        const tarball = files.find(f => f.versionId === v.id);
        return [v.version, {
          name, version: v.version,
          ...(v.metadata as Record<string, unknown>),
          dist: tarball ? {
            tarball: `${base}/packages/npm/${encodeURIComponent(name)}/versions/${encodeURIComponent(v.version)}/files/${encodeURIComponent(tarball.name)}`,
            shasum: tarball.shasum,
          } : {},
        }];
      })),
    };
    return c.json(out);
  });

  auth.put("/:ns/:repo/-/npm/:pkg", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as {
      name?: string;
      versions?: Record<string, Record<string, unknown>>;
      _attachments?: Record<string, { content_type: string; data: string }>;
    };
    if (!body.name || !body.versions) throw new ValidationError("bad npm payload");
    const out: Array<Record<string, unknown>> = [];
    for (const [version, meta] of Object.entries(body.versions)) {
      const att = body._attachments && Object.values(body._attachments)[0];
      if (!att) throw new ValidationError("missing_attachment");
      const buf = Buffer.from(att.data, "base64");
      const filename = `${body.name}-${version}.tgz`;
      const result = await publish(db, store, {
        repoId: repo.id, kind: "npm", name: body.name, version,
        metadata: meta,
        files: [{ filename, contentType: att.content_type, body: buf }],
      });
      out.push(result);
    }
    return c.json({ ok: true, published: out });
  });

  return { auth, pub };
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return undefined; }
}
