import { minimatch } from "minimatch";
import type { GitService } from "./git.js";
import type { MergePolicy } from "./merge-policy.js";

const POLICY_PATH = ".clawhub/policies/merge.yml";

// Tiny, hand-rolled YAML subset so we don't pull in a dep. Supports:
//   key: value
//   key: "quoted"
//   key: true/false
//   key: 123
//   list items as "  - value"
//   nested maps with indentation (2 spaces)
export function parsePolicyYaml(input: string): Record<string, unknown> {
  const lines = input.split(/\r?\n/).filter(l => !l.trim().startsWith("#") && l.trim() !== "");
  type Frame = { indent: number; value: Record<string, unknown> | Array<unknown>; parent?: { map: Record<string, unknown>; key: string } };
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, value: root }];

  for (const raw of lines) {
    const indent = raw.match(/^( *)/)![1].length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];

    if (line.startsWith("- ")) {
      // If the frame was created as a pending map but we're now seeing "- ",
      // upgrade the parent's slot from {} to [] and point the frame at it.
      if (!Array.isArray(top.value) && top.parent) {
        const arr: Array<unknown> = [];
        top.parent.map[top.parent.key] = arr;
        top.value = arr;
      }
      if (!Array.isArray(top.value)) continue;
      const value = line.slice(2);
      if (value.endsWith(":")) {
        const map: Record<string, unknown> = {};
        (top.value as Array<unknown>).push(map);
        stack.push({ indent, value: map });
      } else {
        (top.value as Array<unknown>).push(coerce(value));
      }
    } else {
      const [key, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      if (Array.isArray(top.value)) continue;
      if (value === "") {
        const next: Record<string, unknown> = {};
        (top.value as Record<string, unknown>)[key] = next;
        stack.push({ indent, value: next, parent: { map: top.value as Record<string, unknown>, key } });
      } else if (value === "[]") {
        (top.value as Record<string, unknown>)[key] = [];
      } else {
        (top.value as Record<string, unknown>)[key] = coerce(value);
      }
    }
  }

  return root;
}

function coerce(v: string): unknown {
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if ((t.startsWith("\"") && t.endsWith("\"")) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

// Detect lists that were created as {} then filled with "- " items.
function arrayifyEmptyMaps(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(arrayifyEmptyMaps);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = arrayifyEmptyMaps(v);
    return out;
  }
  return obj;
}

export async function readRepoPolicy(git: GitService, ns: string, repo: string, commit: string): Promise<MergePolicy | null> {
  try {
    const content = await git.fileAt(ns, repo, commit, POLICY_PATH);
    if (!content) return null;
    const parsed = arrayifyEmptyMaps(parsePolicyYaml(content)) as Record<string, unknown>;
    return coerceToPolicy(parsed);
  } catch { return null; }
}

export function coerceToPolicy(raw: Record<string, unknown>): MergePolicy {
  return {
    requireHumanApproval: (raw.requireHumanApproval as "always" | "never" | "if_risk_at_least") ?? "if_risk_at_least",
    requireHumanApprovalLevel: (raw.requireHumanApprovalLevel as MergePolicy["requireHumanApprovalLevel"]) ?? "high",
    minApprovalsTotal: Number(raw.minApprovalsTotal ?? 1),
    minApprovalsHuman: Number(raw.minApprovalsHuman ?? 0),
    allowSelfReview: Boolean(raw.allowSelfReview ?? false),
    ciRequired: Boolean(raw.ciRequired ?? false),
    pathOverrides: (Array.isArray(raw.pathOverrides) ? (raw.pathOverrides as Array<{ glob: string; requireHuman: boolean }>) : []),
    trustedAgents: Array.isArray(raw.trustedAgents) ? (raw.trustedAgents as string[]) : [],
    allowedMergeMethods: Array.isArray(raw.allowedMergeMethods) ? (raw.allowedMergeMethods as MergePolicy["allowedMergeMethods"]) : undefined,
    defaultMergeMethod: raw.defaultMergeMethod as MergePolicy["defaultMergeMethod"],
  };
}

// Evaluate per-path overrides against a scope list.
export function pathRequiresHuman(policy: MergePolicy, scope: string[]): boolean {
  return scope.some(p => policy.pathOverrides.some(o => o.requireHuman && minimatch(p, o.glob)));
}
