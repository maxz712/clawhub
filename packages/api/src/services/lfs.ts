import { createHash } from "node:crypto";
import { mkdir, open, stat, rename, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { lfsObjects } from "../models/schema.js";
import { ValidationError } from "./errors.js";

// An LFS oid is a sha256 content address: exactly 64 lowercase hex chars.
// Enforcing that shape is the whole guard — it rejects `..`, encoded separators
// (Hono URL-decodes `:oid`, so `%2f` arrives as a REAL separator), absolute
// paths and NUL bytes in one predicate, with no path arithmetic to reason
// about. Without it the client-supplied oid reaches `path.resolve` below and
// escapes the store entirely (arbitrary file write → git-hook RCE, and
// arbitrary read of anything the API process can open).
export const LFS_OID_RE = /^[a-f0-9]{64}$/;

export function isValidOid(oid: unknown): oid is string {
  return typeof oid === "string" && LFS_OID_RE.test(oid);
}

/** Validate a client-supplied oid at the route boundary. Throws a 400, never a 500. */
export function assertValidOid(oid: unknown): string {
  if (!isValidOid(oid)) throw new ValidationError("invalid_oid");
  return oid;
}

export class LfsStore {
  constructor(public readonly baseDir: string) {}

  private pathFor(repoId: string, oid: string): string {
    // Defence in depth, mirroring LocalObjectStore.pathFor: the routes already
    // validate oids, but a future caller that forgets must still not escape.
    // Both segments are checked — repoId is DB-sourced today, not forever.
    for (const seg of [repoId, oid]) {
      if (typeof seg !== "string" || seg.includes("..") || path.isAbsolute(seg)) throw new ValidationError("illegal_lfs_path");
    }
    const root = path.resolve(this.baseDir, "lfs");
    const resolved = path.resolve(root, repoId, oid.slice(0, 2), oid);
    if (!resolved.startsWith(root + path.sep)) throw new ValidationError("illegal_lfs_path");
    return resolved;
  }

  async writeObject(repoId: string, oid: string, body: ReadableStream<Uint8Array> | Buffer): Promise<{ size: number; shaHex: string }> {
    const dest = this.pathFor(repoId, oid);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${Date.now()}`;
    const fh = await open(tmp, "w");
    const hash = createHash("sha256");
    let size = 0;
    try {
      try {
        if (Buffer.isBuffer(body)) {
          hash.update(body); size = body.length;
          await fh.write(body);
        } else {
          const reader = (body as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              hash.update(value);
              size += value.length;
              await fh.write(value);
            }
          }
        }
      } finally {
        await fh.close();
      }
      const shaHex = hash.digest("hex");
      // Publish only what passes its own integrity check. The digest used to be
      // compared by the caller AFTER the rename, so a body that didn't hash to
      // the declared oid still landed at the destination and the 400 was
      // cosmetic. A rejected upload must leave nothing behind.
      if (shaHex !== oid) {
        await rm(tmp, { force: true });
        return { size, shaHex };
      }
      await rename(tmp, dest);
      return { size, shaHex };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async openObject(repoId: string, oid: string): Promise<{ stream: NodeJS.ReadableStream; size: number } | null> {
    const p = this.pathFor(repoId, oid);
    try {
      const s = await stat(p);
      return { stream: createReadStream(p), size: s.size };
    } catch { return null; }
  }

  async exists(repoId: string, oid: string): Promise<boolean> {
    // pathFor stays OUTSIDE the try (as in openObject): a containment violation
    // is a caller bug to surface, not a missing file to report as `false`.
    const p = this.pathFor(repoId, oid);
    try { await stat(p); return true; } catch { return false; }
  }
}

export async function markUploaded(db: DB, repoId: string, oid: string, size: number): Promise<void> {
  await db.insert(lfsObjects).values({ repoId, oid, size, uploaded: true })
    .onConflictDoUpdate({
      target: [lfsObjects.repoId, lfsObjects.oid],
      set: { uploaded: true, size },
    });
}

export async function getObjectRow(db: DB, repoId: string, oid: string) {
  return (await db.select().from(lfsObjects).where(and(eq(lfsObjects.repoId, repoId), eq(lfsObjects.oid, oid))).limit(1))[0] ?? null;
}
