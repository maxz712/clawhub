import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { branches } from "../models/schema.js";
import type { GitService } from "../services/git.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead } from "../services/repo-access.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { renderMarkdown } from "../services/docs-render.js";
import { queryCodeGraph } from "../services/code-graph.js";

const MAX_BLOB_BYTES = 512 * 1024;
// Cap for the raw byte serve — the whole file is read into memory, so refuse
// anything huge (those belong in LFS). 25 MiB covers typical images/PDFs.
const MAX_RAW_BYTES = 25 * 1024 * 1024;
const README_CANDIDATES = ["README.md", "readme.md", "Readme.md", "README"];

// Content-type for the raw/download endpoint. Only RASTER image types are served
// inline (safe in an <img>); SVG and everything else download as an attachment so
// untrusted markup/scripts never render in the API origin.
const RASTER_IMAGE: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
};
const OTHER_MIME: Record<string, string> = { pdf: "application/pdf", svg: "image/svg+xml" };
export function rawContentType(path: string): { type: string; inline: boolean } {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (RASTER_IMAGE[ext]) return { type: RASTER_IMAGE[ext], inline: true };
  if (OTHER_MIME[ext]) return { type: OTHER_MIME[ext], inline: false };
  return { type: "application/octet-stream", inline: false };
}

/**
 * Split a GitHub-style `<ref>/<path...>` slug into a ref and a path. Branch names
 * may contain slashes, so the longest branch name that prefix-matches the slug
 * wins; otherwise the first segment is the ref (a SHA or tag). Mirrors the
 * dashboard's splitRefPath so the API and the UI agree on the boundary.
 */
export function splitRefPath(slug: string, branchNames: string[]): { ref: string; path: string } {
  const joined = slug.replace(/^\/+|\/+$/g, "");
  let best = "";
  for (const b of branchNames) {
    if ((joined === b || joined.startsWith(b + "/")) && b.length > best.length) best = b;
  }
  if (best) return { ref: best, path: joined.slice(best.length).replace(/^\/+/, "") };
  const segs = joined.split("/");
  return { ref: segs[0] ?? "", path: segs.slice(1).join("/") };
}

async function serveTree(c: Context, git: GitService, ns: string, repo: string, ref: string, path: string) {
  const cleanPath = path.replace(/^\/+|\/+$/g, "");
  let entries;
  try {
    entries = await git.listTree(ns, repo, ref, cleanPath);
  } catch {
    throw new NotFoundError(`tree ${ref}:${cleanPath}`);
  }
  // Enrich each entry with the most-recent commit that touched it — ONE bounded
  // `git log` for the whole directory, not a spawn per entry. Best-effort: if it
  // throws or an entry falls outside the scanned commit window, the entry simply
  // renders without last-commit info.
  const lastCommits = await git.lastCommitsForTree(ns, repo, ref, cleanPath, entries.map(e => e.name));
  return c.json({ ref, path: cleanPath, entries: entries.map(e => ({ ...e, lastCommit: lastCommits.get(e.name) ?? null })) });
}

/**
 * Read-only code browsing for the dashboard: directory listings, file
 * contents, and the rendered README. Mounted under /api/v1/repos.
 */
export function createCodeRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // v3 P6 — Graphify: query the structural code graph (symbols + import
  // edges). Read access; agents use it for structure discovery.
  app.get("/:ns/:repo/code/graph", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const q = c.req.query();
    const result = await queryCodeGraph(db, repo.id, {
      symbol: q.symbol || undefined,
      path: q.path || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return c.json(result);
  });

  app.get("/:ns/:repo/branches", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(branches).where(eq(branches.repoId, repo.id));
    return c.json({
      branches: rows
        .map(b => ({ name: b.name, headCommit: b.headCommit, isDefault: b.name === repo.defaultBranch, protection: b.protection ?? null }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)),
    });
  });

  // Query-param form (what the dashboard's api.ts uses): /tree?ref=&path=
  app.get("/:ns/:repo/tree", async c => {
    const { namespace, repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    const path = (c.req.query("path") ?? "").replace(/^\/+|\/+$/g, "");
    return await serveTree(c, git, namespace.name, repo.name, ref, path);
  });

  // GitHub-style path form: /tree/<ref>/<path...>. This mirrors the dashboard's
  // URL shape (/repos/:ns/:repo/tree/<ref>/<path>) so a direct API request to the
  // obvious path works instead of 404ing. The ROOT-of-ref cases — /tree/main and
  // /tree/main/ (trailing slash, empty path) — are explicitly handled: a bare ref
  // with no path lists the repo root.
  //
  // Branch names can contain slashes, so the ref/path boundary is resolved
  // greedily against the repo's branch list (longest matching branch wins),
  // matching the dashboard's splitRefPath. A ref that isn't a known branch (a SHA
  // or tag) is taken as the first segment.
  app.get("/:ns/:repo/tree/:ref{.+}", async c => {
    const { namespace, repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    // The {.+} param captures everything after /tree/, slashes included. Strip a
    // trailing slash (the /tree/main/ case) before splitting.
    const slug = c.req.param("ref").replace(/\/+$/, "");
    const branchRows = await db.select({ name: branches.name }).from(branches).where(eq(branches.repoId, repo.id));
    const { ref, path } = splitRefPath(slug, branchRows.map(b => b.name));
    if (!ref) throw new NotFoundError("tree ref");
    return await serveTree(c, git, namespace.name, repo.name, ref, path);
  });

  app.get("/:ns/:repo/blob", async c => {
    const { namespace, repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    const path = (c.req.query("path") ?? "").replace(/^\/+/, "");
    if (!path) throw new NotFoundError("blob path");
    // Read raw bytes so size, binary-detection, and truncation are all in BYTES.
    // (The old path decoded to a JS string first, so `size`/truncation used
    // UTF-16 code units — wrong for any multi-byte content — and binary sniffing
    // ran on the lossy-decoded text instead of the real bytes.)
    const bytes = await git.fileBytesAt(namespace.name, repo.name, ref, path);
    if (bytes === null) throw new NotFoundError(`blob ${ref}:${path}`);
    // Git's own heuristic: a NUL byte in the first 8KB means binary.
    const binary = bytes.subarray(0, 8192).includes(0);
    const size = bytes.length;
    const truncated = size > MAX_BLOB_BYTES;
    return c.json({
      ref, path,
      size,
      binary,
      truncated,
      content: binary ? null : bytes.subarray(0, MAX_BLOB_BYTES).toString("utf8"),
    });
  });

  // Raw byte stream for download / inline image preview. blob (the JSON view)
  // returns content:null for binary; this serves the actual bytes with a
  // content-type + Content-Disposition. Authenticated like the rest of code.ts;
  // the dashboard fetches with the bearer header and turns the response into an
  // object URL (so private-repo images preview without a token in the URL).
  app.get("/:ns/:repo/raw", async c => {
    const { namespace, repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    const path = (c.req.query("path") ?? "").replace(/^\/+/, "");
    if (!path) throw new NotFoundError("blob path");
    // Refuse to load an enormous file fully into memory (DoS guard) — large
    // binaries belong in LFS, which has its own streaming download path.
    const size = await git.blobSizeAt(namespace.name, repo.name, ref, path);
    if (size !== null && size > MAX_RAW_BYTES) {
      throw new ValidationError(`file too large to serve inline (${size} bytes > ${MAX_RAW_BYTES}); use git/LFS to fetch it`);
    }
    const bytes = await git.fileBytesAt(namespace.name, repo.name, ref, path);
    if (bytes === null) throw new NotFoundError(`blob ${ref}:${path}`);
    const filename = (path.split("/").pop() ?? "file").replace(/["\r\n]/g, "");
    const { type, inline } = rawContentType(path);
    c.header("Content-Type", type);
    c.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(bytes as unknown as ArrayBuffer);
  });

  app.get("/:ns/:repo/readme", async c => {
    const { namespace, repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    for (const name of README_CANDIDATES) {
      const content = await git.fileAt(namespace.name, repo.name, ref, name);
      if (content !== null) return c.json({ ref, name, html: renderMarkdown(content) });
    }
    return c.json({ ref, name: null, html: null });
  });

  return app;
}
