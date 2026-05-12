import { randomBytes, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import Redis from "ioredis";
import type { DB } from "../models/db.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;

let client: Redis | null = null;
let clientDisabled = false;
function getClient(): Redis | null {
  if (clientDisabled) return null;
  if (client) return client;
  try {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 1_500,
    });
    client.on("error", () => { /* swallow */ });
    client.connect().catch(() => { clientDisabled = true; });
    return client;
  } catch { return null; }
}

const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/**
 * Acquire a repo-scoped Redis lock for a critical section (merge into default
 * branch, code-index refresh, etc.). Pushes do **not** need this — only the
 * server-side merge does, and only one writer at a time per repo.
 *
 * Falls back to running the work without a lock when Redis is unreachable. This
 * is deliberate: a missing lock degrades to "last-write-wins for the merge"
 * which is the same behavior as today and won't take the API down. Production
 * deployments should monitor Redis liveness.
 */
export async function withRepoLock<T>(
  repoId: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; waitMs?: number; kind?: string } = {},
): Promise<T> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const wait = opts.waitMs ?? DEFAULT_WAIT_MS;
  const kind = opts.kind ?? "merge";
  const key = `clawhub:repolock:${kind}:${repoId}`;
  const token = randomBytes(12).toString("base64url");

  const r = getClient();
  if (!r || r.status !== "ready") return fn();

  const deadline = Date.now() + wait;
  for (;;) {
    let ok: "OK" | null = null;
    try { ok = await r.set(key, token, "PX", ttl, "NX") as "OK" | null; }
    catch { ok = null; break; } // Redis gone after we got past the initial check — degrade.
    if (ok === "OK") {
      try {
        return await fn();
      } finally {
        try { await r.eval(RELEASE_LUA, 1, key, token); } catch { /* lock will TTL-expire */ }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`repo_lock_timeout:${kind}:${repoId}`);
    }
    await new Promise(res => setTimeout(res, 40 + Math.floor(Math.random() * 60)));
  }
  // Fall-through: Redis disappeared mid-loop. Run without the lock.
  return fn();
}

/**
 * Postgres advisory lock — taken inside a transaction; auto-released on COMMIT
 * or ROLLBACK. Use this around the Change upsert + branch update so two
 * concurrent pushes to the same branch can't lose trailer metadata.
 *
 * Key derivation: 64-bit hash of `repoId|branch`. Drizzle's `pg-core` ships
 * `pg_advisory_xact_lock(bigint)` so we hash to a signed-bigint range.
 */
export function advisoryLockKey(repoId: string, branch: string): bigint {
  const h = createHash("sha256").update(`${repoId}|${branch}`).digest();
  // Take 8 bytes, force MSB to 0 to stay in signed positive bigint range.
  const view = h.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return view;
}

export async function withChangeUpsertLock<T>(
  db: DB,
  repoId: string,
  branch: string,
  fn: (tx: DB) => Promise<T>,
): Promise<T> {
  // Drizzle pg's `db.transaction` returns the callback result.
  return db.transaction(async tx => {
    const key = advisoryLockKey(repoId, branch);
    // pg_advisory_xact_lock auto-releases at the end of the txn.
    await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
    return fn(tx as unknown as DB);
  });
}
