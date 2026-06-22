import { describe, it, expect } from "vitest";
import { branchProtectionViolation, type BranchProtection } from "../src/services/changes.js";

// Batch 5: requiredApprovals + requirePullRequest were declared in
// BranchProtection but read NOWHERE — a repo admin could set them and they'd
// gate nothing. branchProtectionViolation is the pure rule the merge path now
// calls; these assert the previously-inert fields actually block a merge.
const base = { method: "merge" as const, ciStatus: "success", changeBranch: "feature/x", defaultBranch: "main", approverCount: 0 };

describe("branchProtectionViolation", () => {
  it("no protection / empty protection → allowed", () => {
    expect(branchProtectionViolation(null, base)).toBeNull();
    expect(branchProtectionViolation({}, base)).toBeNull();
  });

  it("requiredApprovals=2 blocks until two distinct approvals exist", () => {
    const p: BranchProtection = { requiredApprovals: 2 };
    expect(branchProtectionViolation(p, { ...base, approverCount: 0 })).toMatch(/2 approving reviews/);
    expect(branchProtectionViolation(p, { ...base, approverCount: 1 })).toMatch(/2 approving reviews/);
    expect(branchProtectionViolation(p, { ...base, approverCount: 2 })).toBeNull();
  });

  it("requirePullRequest blocks a direct merge of the protected branch into itself", () => {
    const p: BranchProtection = { requirePullRequest: true };
    expect(branchProtectionViolation(p, { ...base, changeBranch: "main", defaultBranch: "main" })).toMatch(/pull request/);
    expect(branchProtectionViolation(p, { ...base, changeBranch: "feature/x", defaultBranch: "main" })).toBeNull();
  });

  it("requireCiSuccess blocks unless CI is success or skipped", () => {
    const p: BranchProtection = { requireCiSuccess: true };
    expect(branchProtectionViolation(p, { ...base, ciStatus: "failure" })).toMatch(/CI success/);
    expect(branchProtectionViolation(p, { ...base, ciStatus: "running" })).toMatch(/CI success/);
    expect(branchProtectionViolation(p, { ...base, ciStatus: "success" })).toBeNull();
    expect(branchProtectionViolation(p, { ...base, ciStatus: "skipped" })).toBeNull();
  });

  it("allowedMergeMethods restricts the method", () => {
    const p: BranchProtection = { allowedMergeMethods: ["squash"] };
    expect(branchProtectionViolation(p, { ...base, method: "merge" })).toMatch(/disallows merge/);
    expect(branchProtectionViolation(p, { ...base, method: "squash" })).toBeNull();
  });

  it("combines rules — the first violated rule wins, all-satisfied → allowed", () => {
    const p: BranchProtection = { requiredApprovals: 1, requirePullRequest: true, requireCiSuccess: true };
    expect(branchProtectionViolation(p, { ...base, approverCount: 1, ciStatus: "success", changeBranch: "feat" })).toBeNull();
    // CI is checked before approvals, so a CI failure surfaces first.
    expect(branchProtectionViolation(p, { ...base, approverCount: 0, ciStatus: "failure" })).toMatch(/CI success/);
  });
});
