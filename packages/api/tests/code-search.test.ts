import { describe, expect, it } from "vitest";
import type { DB } from "../src/models/db.js";
import type { GitService } from "../src/services/git.js";
import { MAX_SCAN_FILES, candidatePaths, extractTrigrams, search } from "../src/services/code-index.js";

// #109 — search() must honor maxHits across ALL candidate files (no hidden
// first-50 cap), scan in a deterministic order, and flag truncation instead of
// silently presenting a capped result as complete.

function fakeDb(shards: Array<{ repoId: string; path: string; trigrams: string[] }>): DB {
  return { select: () => ({ from: () => ({ where: async () => shards }) }) } as unknown as DB;
}

function fakeGit(contentByPath: Map<string, string>): { git: GitService; calls: string[][] } {
  const calls: string[][] = [];
  const git = {
    filesAt: async (_ns: string, _repo: string, _commit: string, paths: string[]) => {
      calls.push(paths);
      return new Map(paths.map(p => [p, contentByPath.get(p) ?? ""]));
    },
  } as unknown as GitService;
  return { git, calls };
}

function repoWithMatches(n: number, query: string): { db: DB; git: GitService; calls: string[][]; paths: string[] } {
  const paths = Array.from({ length: n }, (_, i) => `src/f${String(i + 1).padStart(4, "0")}.ts`);
  const content = `const ${query} = 1;`;
  const shards = paths.map(path => ({ repoId: "r1", path, trigrams: extractTrigrams(content) }));
  const { git, calls } = fakeGit(new Map(paths.map(p => [p, content])));
  return { db: fakeDb(shards), git, calls, paths };
}

describe("code-index search", () => {
  it("returns matches from files beyond the 50th, up to maxHits", async () => {
    const { db, git, calls, paths } = repoWithMatches(250, "needleValue");
    const res = await search(db, git, "ns", "repo", "r1", "head", "needleValue", 500);
    expect(res.hits).toHaveLength(250);
    expect(res.hits.map(h => h.path)).toContain(paths[249]);
    expect(res.truncated).toBe(false);
    expect(res.scannedFiles).toBe(250);
    // Reads are batched (READ_CHUNK=200), not a single 50-file slice.
    expect(calls.map(c => c.length)).toEqual([200, 50]);
  });

  it("scans candidates in deterministic (sorted) order regardless of DB row order", async () => {
    const content = "const needleValue = 1;";
    const shuffled = ["src/z.ts", "src/a.ts", "src/m.ts"].map(path => ({ repoId: "r1", path, trigrams: extractTrigrams(content) }));
    const db = fakeDb(shuffled);
    expect(await candidatePaths(db, "r1", "needleValue")).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
    const { git } = fakeGit(new Map(shuffled.map(s => [s.path, content])));
    const first = await search(db, git, "ns", "repo", "r1", "head", "needleValue", 500);
    const second = await search(db, git, "ns", "repo", "r1", "head", "needleValue", 500);
    expect(first.hits).toEqual(second.hits);
    expect(first.hits.map(h => h.path)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("flags truncation and stops fetching when maxHits is reached mid-scan", async () => {
    const { db, git, calls } = repoWithMatches(250, "needleValue");
    const res = await search(db, git, "ns", "repo", "r1", "head", "needleValue", 10);
    expect(res.hits).toHaveLength(10);
    expect(res.truncated).toBe(true);
    // Early exit: the second READ_CHUNK batch is never fetched.
    expect(calls).toHaveLength(1);
  });

  it("does not flag truncation when all candidates are scanned within maxHits", async () => {
    const { db, git } = repoWithMatches(10, "needleValue");
    const res = await search(db, git, "ns", "repo", "r1", "head", "needleValue", 500);
    expect(res.hits).toHaveLength(10);
    expect(res.truncated).toBe(false);
  });

  it("flags truncation when candidates exceed MAX_SCAN_FILES even below maxHits", async () => {
    // Trigram false-positive shards: candidates match, content mostly does not —
    // isolates the scan-file cap from the maxHits cap.
    const query = "needleValue";
    const paths = Array.from({ length: MAX_SCAN_FILES + 1 }, (_, i) => `src/f${String(i + 1).padStart(5, "0")}.ts`);
    const shards = paths.map(path => ({ repoId: "r1", path, trigrams: extractTrigrams(query) }));
    const contents = new Map(paths.map(p => [p, "no match here"]));
    contents.set(paths[0], `const ${query} = 1;`);
    const { git } = fakeGit(contents);
    const res = await search(fakeDb(shards), git, "ns", "repo", "r1", "head", query, 500);
    expect(res.hits).toHaveLength(1);
    expect(res.truncated).toBe(true);
    expect(res.scannedFiles).toBe(MAX_SCAN_FILES);
  });

  it("returns an untruncated empty result when nothing matches", async () => {
    const { git } = fakeGit(new Map());
    const res = await search(fakeDb([]), git, "ns", "repo", "r1", "head", "needleValue", 500);
    expect(res).toEqual({ hits: [], truncated: false, scannedFiles: 0 });
  });
});
