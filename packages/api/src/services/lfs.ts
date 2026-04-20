import { createHash } from "node:crypto";
import { mkdir, open, stat, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { lfsObjects } from "../models/schema.js";

export class LfsStore {
  constructor(public readonly baseDir: string) {}

  private pathFor(repoId: string, oid: string): string {
    return path.resolve(this.baseDir, "lfs", repoId, oid.slice(0, 2), oid);
  }

  async writeObject(repoId: string, oid: string, body: ReadableStream<Uint8Array> | Buffer): Promise<{ size: number; shaHex: string }> {
    const dest = this.pathFor(repoId, oid);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${Date.now()}`;
    const fh = await open(tmp, "w");
    const hash = createHash("sha256");
    let size = 0;
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
    await rename(tmp, dest);
    return { size, shaHex: hash.digest("hex") };
  }

  async openObject(repoId: string, oid: string): Promise<{ stream: NodeJS.ReadableStream; size: number } | null> {
    const p = this.pathFor(repoId, oid);
    try {
      const s = await stat(p);
      return { stream: createReadStream(p), size: s.size };
    } catch { return null; }
  }

  async exists(repoId: string, oid: string): Promise<boolean> {
    try { await stat(this.pathFor(repoId, oid)); return true; } catch { return false; }
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
