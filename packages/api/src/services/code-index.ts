import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { codeIndexShards } from "../models/schema.js";
import type { GitService } from "./git.js";

// Zoekt-style trigram index, kept small: per-file trigram set stored as JSON array
// of 3-char strings. Lookup intersects shards by required trigrams, then uses the
// git content as the verifier to grep exact matches. This gives fast candidate
// selection even on big repos without pulling in a native index.

const TEXT_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "rb", "php", "c", "h", "cpp", "hpp", "cs", "md", "yml", "yaml", "json", "toml", "sh", "sql"]);

function extractTrigrams(content: string): string[] {
  const s = content.toLowerCase();
  if (s.length < 3) return [];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) {
    const tri = s.slice(i, i + 3);
    // Skip trigrams that are entirely whitespace to cut noise.
    if (!/\s{3}/.test(tri)) out.add(tri);
  }
  return Array.from(out);
}

function pathIsIndexable(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) return false;
  return TEXT_EXT.has(ext);
}

export async function indexRepoAtCommit(db: DB, git: GitService, ns: string, repoName: string, repoId: string, commit: string, opts: { maxFiles?: number; maxFileBytes?: number } = {}): Promise<{ indexed: number }> {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxBytes = opts.maxFileBytes ?? 200_000;

  const ls = await git.open(ns, repoName).raw(["ls-tree", "-r", "--name-only", commit]).catch(() => "");
  const paths = ls.split("\n").filter(Boolean).filter(pathIsIndexable).slice(0, maxFiles);

  // Drop stale shards.
  await db.delete(codeIndexShards).where(eq(codeIndexShards.repoId, repoId));

  let indexed = 0;
  const batch: Array<{ repoId: string; commitSha: string; path: string; trigrams: string[] }> = [];
  for (const p of paths) {
    const content = await git.fileAt(ns, repoName, commit, p);
    if (!content || content.length > maxBytes) continue;
    const tris = extractTrigrams(content);
    if (tris.length === 0) continue;
    batch.push({ repoId, commitSha: commit, path: p, trigrams: tris });
    indexed++;
    if (batch.length >= 100) {
      await db.insert(codeIndexShards).values(batch);
      batch.length = 0;
    }
  }
  if (batch.length) await db.insert(codeIndexShards).values(batch);
  return { indexed };
}

export async function candidatePaths(db: DB, repoId: string, query: string): Promise<string[]> {
  const needle = query.toLowerCase();
  if (needle.length < 3) return [];
  const required = extractTrigrams(needle);
  if (!required.length) return [];

  // Pull the full shard list for the repo then filter in-process. Fine for small
  // to mid repos; for large installations this would move to a dedicated store.
  const shards = await db.select().from(codeIndexShards).where(eq(codeIndexShards.repoId, repoId));
  return shards
    .filter(s => {
      const tris = s.trigrams as string[];
      const set = new Set(tris);
      return required.every(t => set.has(t));
    })
    .map(s => s.path);
}

export async function search(db: DB, git: GitService, ns: string, repoName: string, repoId: string, commit: string, query: string, maxHits = 200): Promise<Array<{ path: string; line: number; excerpt: string }>> {
  const candidates = await candidatePaths(db, repoId, query);
  if (!candidates.length) return [];
  const re = new RegExp(escapeRegex(query), "i");
  const hits: Array<{ path: string; line: number; excerpt: string }> = [];
  for (const p of candidates.slice(0, 50)) {
    const content = await git.fileAt(ns, repoName, commit, p);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push({ path: p, line: i + 1, excerpt: lines[i].slice(0, 240) });
        if (hits.length >= maxHits) return hits;
      }
    }
  }
  return hits;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function dropIndex(db: DB, repoId: string): Promise<void> {
  await db.delete(codeIndexShards).where(eq(codeIndexShards.repoId, repoId));
}
