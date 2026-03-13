import { minimatch } from "minimatch";
import type { PermissionRule } from "../models/schema.js";

export interface PermissionCheckResult {
  allowed: boolean;
  requiresApproval: boolean;
  autoMerge: boolean;
  deniedPaths: string[];
  matchedRules: PermissionRule[];
}

export interface PermissionConditions {
  max_files?: number;
  no_deletions?: boolean;
}

/**
 * Evaluates permission rules against a set of file changes.
 * Rules are evaluated in order of specificity:
 * 1. deny_path rules block access (highest priority)
 * 2. require_approval rules force human review
 * 3. auto_merge rules allow automatic merging
 * 4. allow_path rules permit changes
 *
 * If no rules match, changes are allowed but require approval (safe default).
 */
export function evaluatePermissions(
  rules: PermissionRule[],
  agentId: string | null,
  filePaths: string[],
  fileActions: string[]
): PermissionCheckResult {
  // Filter rules applicable to this agent (null agentId on rule = applies to all)
  const applicableRules = rules.filter(
    (r) => r.agentId === null || r.agentId === agentId
  );

  const matchedRules: PermissionRule[] = [];
  const deniedPaths: string[] = [];
  let hasAutoMerge = false;
  let hasRequireApproval = false;
  let hasDeny = false;

  for (const filePath of filePaths) {
    for (const rule of applicableRules) {
      if (!minimatch(filePath, rule.pattern, { dot: true })) {
        continue;
      }

      matchedRules.push(rule);

      if (rule.ruleType === "deny_path") {
        deniedPaths.push(filePath);
        hasDeny = true;
      } else if (rule.ruleType === "require_approval") {
        hasRequireApproval = true;
      } else if (rule.ruleType === "auto_merge") {
        hasAutoMerge = true;
      }
    }
  }

  // Check conditions on matched rules
  for (const rule of matchedRules) {
    const conditions = rule.conditions as PermissionConditions | null;
    if (!conditions) continue;

    if (conditions.max_files && filePaths.length > conditions.max_files) {
      hasRequireApproval = true;
      hasAutoMerge = false;
    }

    if (conditions.no_deletions && fileActions.includes("delete")) {
      hasRequireApproval = true;
      hasAutoMerge = false;
    }
  }

  // Deny takes highest priority
  if (hasDeny) {
    return {
      allowed: false,
      requiresApproval: false,
      autoMerge: false,
      deniedPaths,
      matchedRules,
    };
  }

  // require_approval overrides auto_merge
  if (hasRequireApproval) {
    return {
      allowed: true,
      requiresApproval: true,
      autoMerge: false,
      deniedPaths: [],
      matchedRules,
    };
  }

  // auto_merge if matched
  if (hasAutoMerge) {
    return {
      allowed: true,
      requiresApproval: false,
      autoMerge: true,
      deniedPaths: [],
      matchedRules,
    };
  }

  // Default: allowed but requires approval
  return {
    allowed: true,
    requiresApproval: true,
    autoMerge: false,
    deniedPaths: [],
    matchedRules,
  };
}
