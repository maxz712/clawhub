import type { GitService } from "./git.js";

export interface CiPipelineDef {
  name?: string;
  steps: Array<{ name?: string; run: string; image?: string; cache?: { key: string; paths: string[] } }>;
  extends?: string;
  cache?: { key: string; paths: string[] };
}

// Parse ClawHub CI YAML. Supports:
//   steps: [...]
//   extends: <relative path to another yaml>
//   cache: { key, paths }
// Recursive `extends` is resolved against the repo tree at a given commit.

export async function loadCiDef(git: GitService, ns: string, repo: string, commit: string, path: string): Promise<CiPipelineDef | null> {
  const visited = new Set<string>();
  return loadRecursive(git, ns, repo, commit, path, visited);
}

async function loadRecursive(git: GitService, ns: string, repo: string, commit: string, path: string, visited: Set<string>): Promise<CiPipelineDef | null> {
  if (visited.has(path)) throw new Error(`ci_cycle:${path}`);
  visited.add(path);
  const raw = await git.fileAt(ns, repo, commit, path);
  if (!raw) return null;
  const parsed = parseYamlSubset(raw);

  let base: CiPipelineDef | null = null;
  if (typeof parsed.extends === "string") {
    const parentPath = resolvePath(path, parsed.extends);
    base = await loadRecursive(git, ns, repo, commit, parentPath, visited);
  }
  const merged: CiPipelineDef = {
    name: (parsed.name as string | undefined) ?? base?.name,
    steps: [...(base?.steps ?? []), ...((parsed.steps as CiPipelineDef["steps"] | undefined) ?? [])],
    cache: (parsed.cache as CiPipelineDef["cache"] | undefined) ?? base?.cache,
  };
  return merged;
}

function resolvePath(from: string, rel: string): string {
  const parts = from.split("/").slice(0, -1).concat(rel.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop(); else out.push(p);
  }
  return out.join("/");
}

// Tiny subset YAML, enough for CI definitions. Reused shape from policy-dsl.
export function parseYamlSubset(input: string): Record<string, unknown> {
  const lines = input.split(/\r?\n/).filter(l => !l.trim().startsWith("#"));
  type Frame = { indent: number; value: Record<string, unknown> | Array<unknown>; parent?: { map: Record<string, unknown>; key: string } };
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, value: root }];

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^( *)/)![1].length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];

    if (line.startsWith("- ")) {
      if (!Array.isArray(top.value) && top.parent) {
        const arr: Array<unknown> = [];
        top.parent.map[top.parent.key] = arr;
        top.value = arr;
      }
      if (!Array.isArray(top.value)) continue;
      const rest = line.slice(2);
      const m = rest.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (m) {
        // A list entry that is itself a map. Push a frame representing the map
        // anchored at this `-` column so sibling keys at indent + 2 fall in.
        const obj: Record<string, unknown> = {};
        (top.value as Array<unknown>).push(obj);
        const k = m[1];
        if (m[2]) obj[k] = coerce(m[2]);
        stack.push({ indent, value: obj });
        if (!m[2]) stack.push({ indent: indent + 2, value: obj, parent: { map: obj, key: k } });
      } else {
        (top.value as Array<unknown>).push(coerce(rest));
      }
    } else {
      if (Array.isArray(top.value)) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const value = m[2];
      if (value === "") {
        const next: Record<string, unknown> = {};
        (top.value as Record<string, unknown>)[key] = next;
        stack.push({ indent, value: next, parent: { map: top.value as Record<string, unknown>, key } });
      } else {
        (top.value as Record<string, unknown>)[key] = coerce(value);
      }
    }
  }
  return root;
}

function coerce(s: string): unknown {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^".*"$/.test(t)) return t.slice(1, -1);
  if (/^\[.*\]$/.test(t)) return t.slice(1, -1).split(",").map(s => coerce(s.trim()));
  return t;
}
