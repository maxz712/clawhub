/**
 * v3 RBAC (docs/redesign-v3.md §2): a role is a named PERMISSION SET + repo
 * scope, assignable to any identity — human or agent. This module is the one
 * catalog: permission keys, implication rules, the legacy {push, review}
 * translation, and the seeded default role definitions.
 *
 * Uniform merge rights (owner decision, 2026-07-06): `change:merge` grants
 * merging to ANY identity that holds it, at any risk — the merge gate
 * evaluates per-repo POLICY identically for humans and agents; there is no
 * kind carve-out. Supervision is a configuration posture (default roles hand
 * agents no merge permission; default policy still requires human review at
 * high risk) — not a hardcoded rule.
 */

export const PERMISSIONS = [
  "repo:read", "repo:write", "repo:admin",
  "change:read", "change:write", "change:review", "change:merge",
  "issue:read", "issue:write",
  "workflow:read", "workflow:write", "workflow:trigger",
  "secrets:write", "secrets:read_metadata",
  "policy:write", "audit:read",
  "memory:read", "memory:write",
  "ops:kill",
] as const;

export type Permission = typeof PERMISSIONS[number];

const VALID = new Set<string>(PERMISSIONS);

// Implications: holding the key on the left implicitly grants the ones on the
// right. Keeps hasPermission() checks intuitive (an Admin needn't enumerate
// every read) while storage stays explicit-only.
const IMPLIES: Partial<Record<Permission, Permission[]>> = {
  "repo:admin": ["repo:write", "policy:write", "secrets:write", "audit:read", "ops:kill"],
  "repo:write": ["repo:read", "change:write", "issue:write", "secrets:read_metadata"],
  "repo:read": ["change:read", "issue:read", "workflow:read", "memory:read"],
  "change:write": ["change:read"],
  "change:review": ["change:read"],
  "change:merge": ["change:read"],
  "issue:write": ["issue:read"],
  "workflow:write": ["workflow:read"],
  "secrets:write": ["secrets:read_metadata"],
  "memory:write": ["memory:read"],
};

/** Expand a permission set through the implication table (transitive). */
export function expandPermissions(perms: Permission[]): Set<Permission> {
  const out = new Set<Permission>();
  const stack = [...perms];
  while (stack.length) {
    const p = stack.pop()!;
    if (out.has(p)) continue;
    out.add(p);
    for (const q of IMPLIES[p] ?? []) stack.push(q);
  }
  return out;
}

export function hasPermission(perms: Permission[], p: Permission): boolean {
  return expandPermissions(perms).has(p);
}

/**
 * Normalize a persisted/PUT `permissions` value into a valid Permission[].
 * Accepts the v3 array shape AND the legacy v2 `{push, review}` object (the
 * read-compat shim — one release, then the data migration makes it moot):
 *   push   → repo:write + change:write + workflow:trigger (an agent that may
 *            push code may also kick workflows — matches v2 behavior where
 *            push implied full write-surface access)
 *   review → change:review
 * Both default true in v2, so a bare {} legacy object maps to Developer-ish.
 */
export function normalizePermissions(raw: unknown): Permission[] {
  if (Array.isArray(raw)) {
    return [...new Set(raw.filter((p): p is Permission => typeof p === "string" && VALID.has(p)))];
  }
  if (raw && typeof raw === "object") {
    const o = raw as { push?: unknown; review?: unknown };
    const out: Permission[] = ["repo:read"];
    if (o.push !== false) out.push("repo:write", "change:write", "issue:write", "workflow:trigger");
    if (o.review !== false) out.push("change:review");
    return out;
  }
  // Unknown shape: err safe — read-only.
  return ["repo:read"];
}

/** Permission groups for the role-editor UI, in display order. */
export const PERMISSION_GROUPS: Array<{ domain: string; permissions: Array<{ key: Permission; label: string }> }> = [
  { domain: "Repository", permissions: [
    { key: "repo:read", label: "Read code and metadata" },
    { key: "repo:write", label: "Push code" },
    { key: "repo:admin", label: "Administer repo settings" },
  ]},
  { domain: "Changes", permissions: [
    { key: "change:read", label: "Read Changes and diffs" },
    { key: "change:write", label: "Open and edit Changes" },
    { key: "change:review", label: "Submit reviews" },
    { key: "change:merge", label: "Merge Changes (any risk, policy permitting)" },
  ]},
  { domain: "Issues", permissions: [
    { key: "issue:read", label: "Read issues" },
    { key: "issue:write", label: "Create and edit issues" },
  ]},
  { domain: "Workflows", permissions: [
    { key: "workflow:read", label: "Read workflow runs" },
    { key: "workflow:write", label: "Configure workflows" },
    { key: "workflow:trigger", label: "Trigger workflow runs" },
  ]},
  { domain: "Secrets", permissions: [
    { key: "secrets:read_metadata", label: "See secret names" },
    { key: "secrets:write", label: "Set and delete secrets" },
  ]},
  { domain: "Policy & audit", permissions: [
    { key: "policy:write", label: "Edit merge policy" },
    { key: "audit:read", label: "Read the audit trail" },
  ]},
  { domain: "Memory", permissions: [
    { key: "memory:read", label: "Read agent memory" },
    { key: "memory:write", label: "Write agent memory" },
  ]},
  { domain: "Ops", permissions: [
    { key: "ops:kill", label: "Pause / kill agents" },
  ]},
];

/** Seeded default roles (clone-and-customize). Order = display order. */
export const DEFAULT_ROLE_DEFS: Array<{ name: string; description: string; permissions: Permission[] }> = [
  {
    name: "Admin",
    description: "Everything — including merge at any risk and repo administration.",
    permissions: [...PERMISSIONS],
  },
  {
    name: "Developer",
    description: "Push code, open Changes, review, work issues, trigger workflows. No merge.",
    permissions: ["repo:read", "repo:write", "change:read", "change:write", "change:review", "issue:read", "issue:write", "workflow:read", "workflow:trigger"],
  },
  {
    name: "Reviewer",
    description: "Review Changes and read the audit trail — cannot push or merge.",
    permissions: ["repo:read", "change:read", "change:review", "issue:read", "audit:read"],
  },
  {
    name: "Auditor",
    description: "Read-only: code, Changes, issues, workflow runs, audit trail, secret names.",
    permissions: ["repo:read", "change:read", "issue:read", "workflow:read", "audit:read", "secrets:read_metadata"],
  },
];

export const DEFAULT_ROLE_NAMES = DEFAULT_ROLE_DEFS.map(d => d.name);
