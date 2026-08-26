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

export async function readRepoPolicy(git: GitService, ns: string, repo: string, commit: string): Promise<Partial<MergePolicy> | null> {
  try {
    const content = await git.fileAt(ns, repo, commit, POLICY_PATH);
    if (!content) return null;
    const parsed = arrayifyEmptyMaps(parsePolicyYaml(content)) as Record<string, unknown>;
    return coerceToPolicy(parsed);
  } catch { return null; }
}

/**
 * #129: a PARTIAL policy — only keys the YAML actually names. The old shape
 * built a full MergePolicy (every absent key defaulted), which made "absent"
 * indistinguishable from "set to the default" and let the adoption site's
 * write DELETE every persisted key the DSL cannot express (requireCiRun,
 * blockAgentDirectDefaultPush, verifyTier, verifiedAutonomy, ...) on every
 * default-branch push — four of them in the permissive direction. The file
 * overlays the DB policy at the adoption site (post-push.ts); it can only set
 * what it says.
 */
export function coerceToPolicy(raw: Record<string, unknown>): Partial<MergePolicy> {
  const out: Partial<MergePolicy> = {};
  if (raw.requireHumanApproval !== undefined) out.requireHumanApproval = raw.requireHumanApproval as MergePolicy["requireHumanApproval"];
  if (raw.requireHumanApprovalLevel !== undefined) out.requireHumanApprovalLevel = raw.requireHumanApprovalLevel as MergePolicy["requireHumanApprovalLevel"];
  if (raw.minApprovalsTotal !== undefined) out.minApprovalsTotal = Number(raw.minApprovalsTotal);
  if (raw.minApprovalsHuman !== undefined) out.minApprovalsHuman = Number(raw.minApprovalsHuman);
  if (raw.allowSelfReview !== undefined) out.allowSelfReview = Boolean(raw.allowSelfReview);
  if (raw.ciRequired !== undefined) out.ciRequired = Boolean(raw.ciRequired);
  if (raw.codeReviewRequiredAtRisk !== undefined) out.codeReviewRequiredAtRisk = raw.codeReviewRequiredAtRisk as MergePolicy["codeReviewRequiredAtRisk"];
  if (Array.isArray(raw.pathOverrides)) out.pathOverrides = raw.pathOverrides as Array<{ glob: string; requireHuman: boolean }>;
  if (Array.isArray(raw.trustedAgents)) out.trustedAgents = raw.trustedAgents as string[];
  if (Array.isArray(raw.allowedMergeMethods)) out.allowedMergeMethods = raw.allowedMergeMethods as MergePolicy["allowedMergeMethods"];
  if (raw.defaultMergeMethod !== undefined) out.defaultMergeMethod = raw.defaultMergeMethod as MergePolicy["defaultMergeMethod"];
  return out;
}

// Evaluate per-path overrides against a scope list.
export function pathRequiresHuman(policy: Pick<MergePolicy, "pathOverrides"> | Partial<MergePolicy>, scope: string[]): boolean {
  return scope.some(p => (policy.pathOverrides ?? []).some(o => o.requireHuman && minimatch(p, o.glob)));
}
