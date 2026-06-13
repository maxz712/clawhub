import type { GitService } from "./git.js";

export interface CiPipelineDef {
  name?: string;
  steps: Array<{ name?: string; run: string; image?: string; cache?: { key: string; paths: string[] } }>;
  extends?: string;
  cache?: { key: string; paths: string[] };
}

// Parse ClawHub CI YAML. Supports:
//   on: push | merge                 (default push)
//   on: schedule  +  cron: "*/5 * * * *"   (cron-driven; 5-field, evaluated UTC)
//   on: event     +  event: change.merged  (ClawHub event-driven)
//   steps: [...]
//   extends: <relative path to another yaml>
//   cache: { key, paths }
// Recursive `extends` is resolved against the repo tree at a given commit.

export type TriggerKind = "push" | "merge" | "schedule" | "event";

export interface PipelineTrigger {
  kind: TriggerKind;
  /** cron expr for schedule triggers; ClawHub event type for event triggers. */
  config: { cron?: string; event?: string };
}

/**
 * When does this pipeline run? `push` (every Change update — tests, lint),
 * `merge` (after landing on the default branch — deploys, releases),
 * `schedule` (a 5-field UTC cron), or `event` (a ClawHub event type).
 *
 * The structured form is persisted on the pipeline row (triggerKind +
 * triggerConfig) at upsert so the scheduler loop and event fan-out can index
 * pipelines without re-parsing YAML every tick. Malformed `on:`/config falls
 * back to `push` — a misconfigured trigger must not silently disable the gate
 * that protects the default branch.
 */
export function parsePipelineTrigger(yaml: string): PipelineTrigger {
  let parsed: Record<string, unknown>;
  try { parsed = parseYamlSubset(yaml); } catch { return { kind: "push", config: {} }; }
  const on = parsed.on;
  if (on === "merge") return { kind: "merge", config: {} };
  if (on === "schedule") {
    const cron = typeof parsed.cron === "string" ? parsed.cron.trim() : "";
    // A schedule pipeline without a usable cron is inert, not a push gate —
    // returning push here would make it run on every Change instead.
    return cron ? { kind: "schedule", config: { cron } } : { kind: "schedule", config: {} };
  }
  if (on === "event") {
    const event = typeof parsed.event === "string" ? parsed.event.trim() : "";
    return event ? { kind: "event", config: { event } } : { kind: "event", config: {} };
  }
  return { kind: "push", config: {} };
}

/**
 * Legacy two-state trigger used by the push + merge enqueue paths. Schedule and
 * event pipelines are neither — they report `push` here only so they never sneak
 * into the on:push gate; the push path additionally filters on triggerKind.
 */
export function pipelineTrigger(yaml: string): "push" | "merge" {
  return parsePipelineTrigger(yaml).kind === "merge" ? "merge" : "push";
}

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
