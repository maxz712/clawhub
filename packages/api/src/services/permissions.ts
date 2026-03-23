import { minimatch } from "minimatch";
import type { PermissionRule } from "../models/schema.js";

export interface PermissionCheckResult {
  allowed: boolean;
  deniedPaths: string[];
  matchedRules: PermissionRule[];
}

/**
 * Evaluates permission rules against a set of file paths.
 *
 * v2 rule types:
 *   - allow_path  — explicitly permits changes to matching paths
 *   - deny_path   — blocks changes to matching paths (highest priority)
 *   - allow_review — permits the agent to submit reviews on matching paths
 *   - deny_review  — blocks the agent from submitting reviews on matching paths
 *
 * Evaluation order:
 *   1. deny_path / deny_review rules block access (highest priority)
 *   2. allow_path / allow_review rules grant access
 *   3. If no rules match a path, access is allowed (permissive default)
 *
 * Merge policy (auto-merge, require approval) is handled separately by merge-policy.ts.
 */
export function evaluatePermissions(
  rules: PermissionRule[],
  agentId: string | null,
  filePaths: string[],
  _fileActions: string[]
): PermissionCheckResult {
  // Filter rules applicable to this agent (null agentId on rule = applies to all)
  const applicableRules = rules.filter(
    (r) => r.agentId === null || r.agentId === agentId
  );

  const matchedRules: PermissionRule[] = [];
  const deniedPaths: string[] = [];

  for (const filePath of filePaths) {
    let isDenied = false;

    for (const rule of applicableRules) {
      if (!minimatch(filePath, rule.pattern, { dot: true })) {
        continue;
      }

      matchedRules.push(rule);

      if (rule.ruleType === "deny_path" || rule.ruleType === "deny_review") {
        isDenied = true;
      }
    }

    if (isDenied) {
      deniedPaths.push(filePath);
    }
  }

  return {
    allowed: deniedPaths.length === 0,
    deniedPaths,
    matchedRules,
  };
}

/**
 * Evaluates review-specific permissions for an agent on a set of file paths.
 * Returns whether the agent is allowed to review changes touching these paths.
 */
export function evaluateReviewPermissions(
  rules: PermissionRule[],
  agentId: string | null,
  filePaths: string[]
): PermissionCheckResult {
  const applicableRules = rules.filter(
    (r) => r.agentId === null || r.agentId === agentId
  );

  const reviewRules = applicableRules.filter(
    (r) => r.ruleType === "allow_review" || r.ruleType === "deny_review"
  );

  const matchedRules: PermissionRule[] = [];
  const deniedPaths: string[] = [];

  for (const filePath of filePaths) {
    let isDenied = false;

    for (const rule of reviewRules) {
      if (!minimatch(filePath, rule.pattern, { dot: true })) {
        continue;
      }

      matchedRules.push(rule);

      if (rule.ruleType === "deny_review") {
        isDenied = true;
      }
    }

    if (isDenied) {
      deniedPaths.push(filePath);
    }
  }

  return {
    allowed: deniedPaths.length === 0,
    deniedPaths,
    matchedRules,
  };
}
