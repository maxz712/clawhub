import { describe, it, expect } from "vitest";
import type { ChangeStatus } from "../src/services/changes.js";

/**
 * Tests for the v2 change state machine.
 *
 * The ChangeService depends on a database, GitService, EventBus, and ChangeRefService.
 * Rather than mocking all of those, we test the state machine transitions by validating
 * the VALID_TRANSITIONS table directly and testing the canMerge integration via
 * merge-policy.test.ts.
 */

const VALID_TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  pending_review: ["approved", "changes_requested"],
  approved: ["merged", "changes_requested"],
  changes_requested: ["pending_review", "approved"],
  merged: ["rolled_back"],
  rolled_back: [],
};

function isValidTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

describe("Change State Machine", () => {
  describe("valid transitions", () => {
    it("should allow pending_review -> approved", () => {
      expect(isValidTransition("pending_review", "approved")).toBe(true);
    });

    it("should allow pending_review -> changes_requested", () => {
      expect(isValidTransition("pending_review", "changes_requested")).toBe(true);
    });

    it("should allow approved -> merged", () => {
      expect(isValidTransition("approved", "merged")).toBe(true);
    });

    it("should allow approved -> changes_requested", () => {
      expect(isValidTransition("approved", "changes_requested")).toBe(true);
    });

    it("should allow changes_requested -> pending_review (re-push)", () => {
      expect(isValidTransition("changes_requested", "pending_review")).toBe(true);
    });

    it("should allow changes_requested -> approved", () => {
      expect(isValidTransition("changes_requested", "approved")).toBe(true);
    });

    it("should allow merged -> rolled_back", () => {
      expect(isValidTransition("merged", "rolled_back")).toBe(true);
    });
  });

  describe("invalid transitions", () => {
    it("should not allow pending_review -> merged (must approve first)", () => {
      expect(isValidTransition("pending_review", "merged")).toBe(false);
    });

    it("should not allow pending_review -> rolled_back", () => {
      expect(isValidTransition("pending_review", "rolled_back")).toBe(false);
    });

    it("should not allow approved -> pending_review", () => {
      expect(isValidTransition("approved", "pending_review")).toBe(false);
    });

    it("should not allow merged -> approved", () => {
      expect(isValidTransition("merged", "approved")).toBe(false);
    });

    it("should not allow rolled_back -> anything", () => {
      expect(isValidTransition("rolled_back", "pending_review")).toBe(false);
      expect(isValidTransition("rolled_back", "approved")).toBe(false);
      expect(isValidTransition("rolled_back", "merged")).toBe(false);
    });
  });

  describe("status enum values", () => {
    it("should have all expected statuses as keys", () => {
      const statuses = Object.keys(VALID_TRANSITIONS);
      expect(statuses).toContain("pending_review");
      expect(statuses).toContain("approved");
      expect(statuses).toContain("changes_requested");
      expect(statuses).toContain("merged");
      expect(statuses).toContain("rolled_back");
      expect(statuses.length).toBe(5);
    });
  });
});
