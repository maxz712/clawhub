/**
 * Warm per-repo dependency cache for non-DinD verification tiers (static/app/
 * services). Kills the per-Change `npm ci` that otherwise dominates a cheap-tier
 * boot, so T1/T2 verify in seconds on a cache hit.
 *
 * SECURITY — the adversarial review's #1 must-fix (cache poisoning). The cache is
 * NEVER written by the sandbox that runs untrusted Change code. Split into:
 *   • POPULATE (on miss): a SEPARATE, locked-down container — the Change tree at its
 *     commit, but ONLY `npm ci --ignore-scripts` (no dependency lifecycle scripts, no
 *     Change code, no app) writes node_modules. Downloaded tarballs are not executed
 *     during install; they only run later inside the contained verify sandbox.
 *   • CONSUME: the populated tree is mounted READ-ONLY (`:ro`) into the verify
 *     sandbox, so a malicious Change can read but never mutate the cache the next
 *     Change reads. Keyed by (repoId, lockfileHash) → never spans tenants, and a
 *     dependency change (new lockfile) mints a new entry, so a poisoned tree can't
 *     masquerade under an honest hash.
 *
 * Build-output caches (.next/cache, .vite, go-build) are intentionally NOT shared
 * here — they're per-run scratch, because they're written by Change code.
 *
 * Robust by degradation: any cache failure falls back to a cold install in the
 * sandbox — slower, never wrong. Admission control + an LRU/ref-count reaper keep a
 * modest host from filling its disk (must-fix #5).
 */
import { mkdir, readdir, stat, rm, writeFile, readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

const CACHE_ROOT = process.env.CLAWHUB_CACHE_ROOT ?? path.join(tmpdir(), "clawhub-verify-cache");
const CACHE_MAX_GB = Number(process.env.CLAWHUB_CACHE_MAX_GB ?? 20);
const CACHE_MIN_FREE_GB = Number(process.env.CLAWHUB_CACHE_MIN_FREE_GB ?? 5);
// Warm reuse is opt-in until validated on a host (default ON; set 0 to force cold).
export const CACHE_ENABLED = process.env.CLAWHUB_VERIFY_CACHE !== "0";

// Lockfiles whose bytes define a dependency set. The hash of (path, content) over
// all of them keys the cache; any dependency bump changes it → a fresh entry.
const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"];

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false);
}

/** sha256 over every discovered lockfile (path + content), or null if none. */
export async function lockfileHash(workdir: string): Promise<string | null> {
  const h = createHash("sha256");
  let found = false;
  // Top-level + one level of common workspace dirs (packages/*, apps/*) — bounded.
  const roots = [workdir];
  for (const sub of ["packages", "apps"]) {
    const d = path.join(workdir, sub);
    if (await exists(d)) {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) roots.push(path.join(d, e.name));
      }
    }
  }
  for (const r of roots.sort()) {
    for (const lf of LOCKFILES) {
      const p = path.join(r, lf);
      if (await exists(p)) {
        h.update(path.relative(workdir, p));
        h.update(await readFile(p));
        found = true;
      }
    }
  }
  return found ? h.digest("hex") : null;
}

export function cacheDir(repoId: string, hash: string): string {
  // repoId + hash are server-controlled / content-derived; still sanitize.
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(CACHE_ROOT, safe(repoId), safe(hash));
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { const s = await stat(p).catch(() => null); if (s) total += s.size; }
    }
  };
  await walk(dir);
  return total;
}

/** Free bytes on the cache filesystem (best-effort; 0 disables the free-space gate). */
async function freeBytes(): Promise<number> {
  try {
    const { statfs } = await import("node:fs/promises") as typeof import("node:fs/promises") & { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> };
    if (!statfs) return 0;
    const s = await statfs(CACHE_ROOT);
    return s.bavail * s.bsize;
  } catch { return 0; }
}

/**
 * Admission control (must-fix #5): may we populate a new cache entry without
 * blowing the disk budget? Reaps unpinned LRU entries to make room; refuses (→ the
 * caller falls back to a cold install) rather than fill the disk.
 */
async function admitNewEntry(): Promise<boolean> {
  await mkdir(CACHE_ROOT, { recursive: true });
  const free = await freeBytes();
  if (free > 0 && free < CACHE_MIN_FREE_GB * 1e9) {
    await reap(/* aggressive */ true);
    const free2 = await freeBytes();
    if (free2 > 0 && free2 < CACHE_MIN_FREE_GB * 1e9) return false;
  }
  if (await totalCacheBytes() > CACHE_MAX_GB * 1e9) await reap(false);
  return true;
}

async function totalCacheBytes(): Promise<number> {
  let total = 0;
  for (const repo of await readdir(CACHE_ROOT, { withFileTypes: true }).catch(() => [])) {
    if (repo.isDirectory()) total += await dirBytes(path.join(CACHE_ROOT, repo.name));
  }
  return total;
}

// A pinned entry is in active use by a run (a `.pin-<runId>` marker). The reaper
// only evicts UNPINNED entries, oldest-accessed first, so it never deletes a tree a
// concurrent run is mid-read of.
async function isPinned(dir: string): Promise<boolean> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".pin-")) return true;
  }
  return false;
}
export async function pin(dir: string, runId: string): Promise<void> {
  await writeFile(path.join(dir, `.pin-${runId.replace(/[^a-zA-Z0-9_-]/g, "")}`), "", { flag: "w" }).catch(() => {});
}
export async function unpin(dir: string, runId: string): Promise<void> {
  await rm(path.join(dir, `.pin-${runId.replace(/[^a-zA-Z0-9_-]/g, "")}`), { force: true }).catch(() => {});
}

async function reap(aggressive: boolean): Promise<void> {
  type Entry = { dir: string; atime: number };
  const entries: Entry[] = [];
  for (const repo of await readdir(CACHE_ROOT, { withFileTypes: true }).catch(() => [])) {
    if (!repo.isDirectory()) continue;
    const rd = path.join(CACHE_ROOT, repo.name);
    for (const e of await readdir(rd, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const dir = path.join(rd, e.name);
      if (await isPinned(dir)) continue;            // never evict an in-use entry
      const s = await stat(dir).catch(() => null);
      entries.push({ dir, atime: s ? s.atimeMs : 0 });
    }
  }
  entries.sort((a, b) => a.atime - b.atime);          // oldest-accessed first
  const drop = aggressive ? entries : entries.slice(0, Math.ceil(entries.length / 2));
  for (const e of drop) await rm(e.dir, { recursive: true, force: true }).catch(() => {});
}

export interface CacheResult {
  /** The cache dir to mount read-only at the workspace's node_modules locations, or null (cold). */
  dir: string | null;
  hit: boolean;
}

/**
 * Ensure a warm dep tree exists for (repoId, lockfileHash). On a miss, populate it
 * via the caller-provided `populate(destDir)` (which MUST run only a locked-down,
 * no-Change-code `npm ci --ignore-scripts` writing node_modules into destDir). On a
 * hit, returns the existing dir to mount read-only. Returns {dir:null} when disabled,
 * no lockfile, admission denied, or population failed → caller does a cold install.
 */
export async function ensureWarmDeps(
  repoId: string,
  workdir: string,
  runId: string,
  populate: (destDir: string) => Promise<boolean>,
): Promise<CacheResult> {
  if (!CACHE_ENABLED) return { dir: null, hit: false };
  const hash = await lockfileHash(workdir);
  if (!hash) return { dir: null, hit: false };
  const dir = cacheDir(repoId, hash);
  const ready = path.join(dir, ".ready");
  if (await exists(ready)) { await pin(dir, runId); return { dir, hit: true }; }
  // Miss: populate under admission control.
  if (!(await admitNewEntry())) return { dir: null, hit: false };
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });
  const ok = await populate(dir).catch(() => false);
  if (!ok) { await rm(dir, { recursive: true, force: true }).catch(() => {}); return { dir: null, hit: false }; }
  await writeFile(ready, new Date(0).toISOString()).catch(() => {}); // marker (no Date.now needed)
  await pin(dir, runId);
  return { dir, hit: false };
}
