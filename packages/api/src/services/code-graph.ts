import { and, eq, inArray, or, ilike } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { codeGraphEdges, codeGraphNodes, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";

/**
 * v3 P6 — Graphify (docs/redesign-v3.md §6): a MECHANICAL structural code
 * graph — symbol definitions per file + import/reference edges between files.
 * Not a memory system (the memory graph is memory_edges): this is derived
 * from source text, deterministically, in the same incremental post-push path
 * as code-index.ts. Dependency-free extraction in the house style: per-
 * language regex def/import matchers, batched reads via git.filesAt.
 *
 * Default ON per repo (repositories.graphifyEnabled; opt-out). Kill switch:
 * CLAWHUB_DISABLE_CODE_GRAPH=1. Consumers: agents (structure discovery via
 * GET .../code/graph) and the dashboard code browser.
 */

export interface SymbolDef { symbol: string; kind: "function" | "class" | "type" | "const" | "route"; line: number }
export interface ImportRef { target: string; line: number }

// ---- per-language extraction (pure, unit-tested) ---------------------------

const TS_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

export function extractSymbols(path: string, content: string): SymbolDef[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const out: SymbolDef[] = [];
  const lines = content.split("\n");
  const push = (symbol: string | undefined, kind: SymbolDef["kind"], line: number) => {
    if (!symbol) return;
    const s = symbol.trim().slice(0, 200);
    if (s) out.push({ symbol: s, kind, line });
  };
  if (TS_EXT.has(ext)) {
    lines.forEach((l, i) => {
      let m = l.match(/^\s*(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/);
      if (m) return push(m[1], "function", i + 1);
      m = l.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
      if (m) return push(m[1], "class", i + 1);
      m = l.match(/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
      if (m) return push(m[1], "type", i + 1);
      m = l.match(/^\s*export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/);
      if (m) return push(m[1], "const", i + 1);
      // Hono/Express-style route registrations — high-signal for agents.
      m = l.match(/\.(?:get|post|put|patch|delete)\(\s*["'`](\/[^"'`]*)["'`]/);
      if (m) return push(m[1], "route", i + 1);
    });
  } else if (ext === "py") {
    lines.forEach((l, i) => {
      let m = l.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/);
      if (m) return push(m[1], "function", i + 1);
      m = l.match(/^\s*class\s+([A-Za-z_][\w]*)/);
      if (m) return push(m[1], "class", i + 1);
    });
  } else if (ext === "go") {
    lines.forEach((l, i) => {
      let m = l.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/);
      if (m) return push(m[1], "function", i + 1);
      m = l.match(/^type\s+([A-Za-z_][\w]*)/);
      if (m) return push(m[1], "type", i + 1);
    });
  }
  return out.slice(0, 500); // bound pathological files
}

export function extractImports(path: string, content: string): ImportRef[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const out: ImportRef[] = [];
  const lines = content.split("\n");
  if (TS_EXT.has(ext)) {
    lines.forEach((l, i) => {
      const m = l.match(/(?:import\s[^"'`]*|require\(\s*|import\(\s*|from\s+)["'`]([^"'`]+)["'`]/);
      if (m && (m[1].startsWith(".") || m[1].startsWith("@/"))) out.push({ target: m[1], line: i + 1 });
    });
  } else if (ext === "py") {
    lines.forEach((l, i) => {
      const m = l.match(/^\s*from\s+(\.[.\w]*)\s+import|^\s*import\s+(\.[.\w]*)/);
      if (m) out.push({ target: (m[1] ?? m[2])!, line: i + 1 });
    });
  }
  // Go import graphs are package-level (module paths) — skipped in v1.
  return out.slice(0, 300);
}

/** Resolve a relative import to a repo path (best-effort, extension-agnostic). */
export function resolveImportTarget(fromPath: string, target: string, knownPaths: Set<string>): string | null {
  let base: string;
  if (target.startsWith("@/")) base = target.slice(2);
  else {
    const dir = fromPath.split("/").slice(0, -1);
    for (const part of target.split("/")) {
      if (part === "." || part === "") continue;
      else if (part === "..") dir.pop();
      else dir.push(part);
    }
    base = dir.join("/");
  }
  // Strip a .js suffix (TS ESM convention imports ./x.js for ./x.ts).
  const stripped = base.replace(/\.(js|mjs|cjs)$/, "");
  const candidates = [
    base, stripped,
    ...["ts", "tsx", "js", "jsx", "py", "go"].map(e => `${stripped}.${e}`),
    ...["ts", "tsx", "js"].map(e => `${stripped}/index.${e}`),
    `${stripped}/__init__.py`,
  ];
  for (const cand of candidates) if (knownPaths.has(cand)) return cand;
  return null;
}

// ---- the incremental build (mirrors indexRepoAtCommit) ---------------------

const GRAPH_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go"]);
const READ_CHUNK = 200;

function pathIsGraphable(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  return !!ext && GRAPH_EXT.has(ext);
}

export function codeGraphEnabled(): boolean {
  return process.env.CLAWHUB_DISABLE_CODE_GRAPH !== "1";
}

export async function buildCodeGraphAtCommit(
  db: DB, git: GitService, ns: string, repoName: string, repoId: string, commit: string,
  opts: { maxFiles?: number; maxFileBytes?: number; sinceCommit?: string } = {},
): Promise<{ files: number; incremental: boolean }> {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxBytes = opts.maxFileBytes ?? 200_000;

  const allLs = await git.open(ns, repoName).raw(["ls-tree", "-r", "--name-only", commit]).catch(() => "");
  const allPaths = allLs.split("\n").filter(Boolean);
  const knownPaths = new Set(allPaths);

  let paths: string[];
  let incremental = false;
  if (opts.sinceCommit && !/^0+$/.test(opts.sinceCommit)) {
    const hasGraph = (await db.select({ id: codeGraphNodes.id }).from(codeGraphNodes).where(eq(codeGraphNodes.repoId, repoId)).limit(1)).length > 0;
    if (hasGraph) {
      // --no-renames: a rename must surface BOTH paths (old = delete, new = add)
      // so the old path's nodes and incoming edges get cleaned up below.
      const changed = await git.diffNameOnly(ns, repoName, opts.sinceCommit, commit, { noRenames: true }).catch(() => null);
      if (changed !== null) {
        incremental = true;
        paths = changed.filter(pathIsGraphable).slice(0, maxFiles);
        // Changed paths absent from the tree at `commit` were deleted (or renamed
        // away). An edge is only ever re-authored when its SOURCE file is
        // reprocessed, so edges POINTING AT a removed file must be pruned here or
        // they dangle forever. Not filtered to graphable: a dstPath can be any
        // resolvable file (e.g. an imported ./data.json).
        const removed = changed.filter(p => !knownPaths.has(p)).slice(0, maxFiles);
        if (!paths.length && !removed.length) return { files: 0, incremental };
        if (removed.length) {
          await db.delete(codeGraphEdges).where(and(eq(codeGraphEdges.repoId, repoId), inArray(codeGraphEdges.dstPath, removed)));
        }
        if (!paths.length) return { files: 0, incremental };
        await db.delete(codeGraphNodes).where(and(eq(codeGraphNodes.repoId, repoId), inArray(codeGraphNodes.path, paths)));
        await db.delete(codeGraphEdges).where(and(eq(codeGraphEdges.repoId, repoId), inArray(codeGraphEdges.srcPath, paths)));
        return { files: await insertPaths(paths), incremental };
      }
    }
  }
  paths = allPaths.filter(pathIsGraphable).slice(0, maxFiles);
  await db.delete(codeGraphNodes).where(eq(codeGraphNodes.repoId, repoId));
  await db.delete(codeGraphEdges).where(eq(codeGraphEdges.repoId, repoId));
  return { files: await insertPaths(paths), incremental: false };

  async function insertPaths(toIndex: string[]): Promise<number> {
    let files = 0;
    for (let i = 0; i < toIndex.length; i += READ_CHUNK) {
      const contents = await git.filesAt(ns, repoName, commit, toIndex.slice(i, i + READ_CHUNK));
      const nodeBatch: Array<typeof codeGraphNodes.$inferInsert> = [];
      const edgeBatch: Array<typeof codeGraphEdges.$inferInsert> = [];
      for (const [p, content] of contents) {
        if (!content || content.length > maxBytes) continue;
        files++;
        for (const s of extractSymbols(p, content)) {
          nodeBatch.push({ repoId, path: p, symbol: s.symbol, kind: s.kind, line: s.line, commitSha: commit });
        }
        for (const imp of extractImports(p, content)) {
          const dst = resolveImportTarget(p, imp.target, knownPaths);
          if (dst && dst !== p) edgeBatch.push({ repoId, srcPath: p, dstPath: dst, kind: "imports", line: imp.line });
        }
      }
      if (nodeBatch.length) await db.insert(codeGraphNodes).values(nodeBatch);
      if (edgeBatch.length) await db.insert(codeGraphEdges).values(edgeBatch);
    }
    return files;
  }
}

/** Is graphify on for this repo (default true; per-repo opt-out; kill switch)? */
export async function graphifyEnabledForRepo(db: DB, repoId: string): Promise<boolean> {
  if (!codeGraphEnabled()) return false;
  const r = (await db.select({ graphifyEnabled: repositories.graphifyEnabled }).from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
  return r?.graphifyEnabled !== false;
}

/** Query surface: symbols by name/path + the import edges around a path. */
export async function queryCodeGraph(db: DB, repoId: string, q: { symbol?: string; path?: string; limit?: number }) {
  const limit = Math.min(500, q.limit ?? 100);
  const conds = [eq(codeGraphNodes.repoId, repoId)];
  if (q.symbol) conds.push(ilike(codeGraphNodes.symbol, `%${q.symbol}%`));
  if (q.path) conds.push(ilike(codeGraphNodes.path, `%${q.path}%`));
  const nodes = await db.select().from(codeGraphNodes).where(and(...conds)).limit(limit);
  const paths = [...new Set(nodes.map(n => n.path))].slice(0, 100);
  const edges = paths.length
    ? await db.select().from(codeGraphEdges).where(and(
        eq(codeGraphEdges.repoId, repoId),
        or(inArray(codeGraphEdges.srcPath, paths), inArray(codeGraphEdges.dstPath, paths)),
      )).limit(1000)
    : [];
  return { nodes, edges };
}
