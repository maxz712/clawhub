import { createHash } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { packageFiles, packages, packageVersions, type Package, type PackageFile, type PackageVersion } from "../models/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";

type Kind = "generic" | "npm" | "oci" | "maven" | "pypi";

export class PackageStore {
  constructor(public readonly baseDir: string) {}

  private pathFor(repoId: string, kind: Kind, name: string, version: string, filename: string): string {
    return path.resolve(this.baseDir, "packages", repoId, kind, encodeURIComponent(name), encodeURIComponent(version), encodeURIComponent(filename));
  }

  async writeFile(repoId: string, kind: Kind, name: string, version: string, filename: string, body: Buffer): Promise<{ path: string; shasum: string; size: number }> {
    const dest = this.pathFor(repoId, kind, name, version, filename);
    await mkdir(path.dirname(dest), { recursive: true });
    const hash = createHash("sha512").update(body).digest("hex");
    const fh = await open(dest, "w");
    try { await fh.write(body); } finally { await fh.close(); }
    return { path: dest, shasum: hash, size: body.length };
  }

  async openFile(absolutePath: string): Promise<{ stream: NodeJS.ReadableStream; size: number } | null> {
    try { const s = await stat(absolutePath); return { stream: createReadStream(absolutePath), size: s.size }; }
    catch { return null; }
  }
}

export async function publish(db: DB, store: PackageStore, input: {
  repoId: string;
  kind: Kind;
  name: string;
  version: string;
  metadata?: Record<string, unknown>;
  files: Array<{ filename: string; contentType?: string; body: Buffer }>;
}): Promise<{ package: Package; version: PackageVersion; files: PackageFile[] }> {
  if (!input.name || !input.version) throw new ValidationError("name and version required");

  let pkg = (await db.select().from(packages).where(and(eq(packages.repoId, input.repoId), eq(packages.kind, input.kind), eq(packages.name, input.name))).limit(1))[0];
  if (!pkg) [pkg] = await db.insert(packages).values({ repoId: input.repoId, kind: input.kind, name: input.name }).returning();

  const existing = (await db.select().from(packageVersions).where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, input.version))).limit(1))[0];
  if (existing) throw new ConflictError("version already published");

  const [ver] = await db.insert(packageVersions).values({
    packageId: pkg.id,
    version: input.version,
    metadata: input.metadata ?? {},
  }).returning();

  const savedFiles: PackageFile[] = [];
  for (const f of input.files) {
    const { path: diskPath, shasum, size } = await store.writeFile(input.repoId, input.kind, input.name, input.version, f.filename, f.body);
    const [row] = await db.insert(packageFiles).values({
      versionId: ver.id,
      name: f.filename,
      contentType: f.contentType ?? "application/octet-stream",
      size,
      shasum,
      path: diskPath,
    }).returning();
    savedFiles.push(row);
  }
  return { package: pkg, version: ver, files: savedFiles };
}

export async function listVersions(db: DB, repoId: string, kind: Kind, name: string) {
  const pkg = (await db.select().from(packages).where(and(eq(packages.repoId, repoId), eq(packages.kind, kind), eq(packages.name, name))).limit(1))[0];
  if (!pkg) throw new NotFoundError("package");
  const versions = await db.select().from(packageVersions).where(eq(packageVersions.packageId, pkg.id)).orderBy(asc(packageVersions.createdAt));
  return { package: pkg, versions };
}

export async function latestVersion(db: DB, repoId: string, kind: Kind, name: string) {
  const pkg = (await db.select().from(packages).where(and(eq(packages.repoId, repoId), eq(packages.kind, kind), eq(packages.name, name))).limit(1))[0];
  if (!pkg) return null;
  const ver = (await db.select().from(packageVersions).where(eq(packageVersions.packageId, pkg.id)).orderBy(desc(packageVersions.createdAt)).limit(1))[0];
  return ver ?? null;
}

export async function getFile(db: DB, repoId: string, kind: Kind, name: string, version: string, filename: string) {
  const pkg = (await db.select().from(packages).where(and(eq(packages.repoId, repoId), eq(packages.kind, kind), eq(packages.name, name))).limit(1))[0];
  if (!pkg) return null;
  const ver = (await db.select().from(packageVersions).where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, version))).limit(1))[0];
  if (!ver) return null;
  const file = (await db.select().from(packageFiles).where(and(eq(packageFiles.versionId, ver.id), eq(packageFiles.name, filename))).limit(1))[0];
  return file ?? null;
}
