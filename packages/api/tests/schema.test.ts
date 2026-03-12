import { describe, it, expect } from "vitest";
import {
  users,
  agents,
  repositories,
  changes,
  permissionRules,
  auditEvents,
  agentTypeEnum,
  authProviderEnum,
  changeStatusEnum,
  riskLevelEnum,
  ruleTypeEnum,
} from "../src/models/schema.js";

describe("Database Schema", () => {
  describe("Users table", () => {
    it("should have the correct columns", () => {
      expect(users.id).toBeDefined();
      expect(users.email).toBeDefined();
      expect(users.authProvider).toBeDefined();
      expect(users.createdAt).toBeDefined();
    });
  });

  describe("Agents table", () => {
    it("should have the correct columns", () => {
      expect(agents.id).toBeDefined();
      expect(agents.name).toBeDefined();
      expect(agents.type).toBeDefined();
      expect(agents.ownerId).toBeDefined();
      expect(agents.publicKey).toBeDefined();
      expect(agents.metadata).toBeDefined();
      expect(agents.createdAt).toBeDefined();
    });
  });

  describe("Repositories table", () => {
    it("should have the correct columns", () => {
      expect(repositories.id).toBeDefined();
      expect(repositories.name).toBeDefined();
      expect(repositories.ownerId).toBeDefined();
      expect(repositories.gitPath).toBeDefined();
      expect(repositories.description).toBeDefined();
      expect(repositories.defaultBranch).toBeDefined();
      expect(repositories.createdAt).toBeDefined();
    });
  });

  describe("Changes table", () => {
    it("should have the correct columns", () => {
      expect(changes.id).toBeDefined();
      expect(changes.repoId).toBeDefined();
      expect(changes.agentId).toBeDefined();
      expect(changes.intent).toBeDefined();
      expect(changes.description).toBeDefined();
      expect(changes.status).toBeDefined();
      expect(changes.riskLevel).toBeDefined();
      expect(changes.branch).toBeDefined();
      expect(changes.diffSummary).toBeDefined();
      expect(changes.semanticDiff).toBeDefined();
      expect(changes.createdAt).toBeDefined();
      expect(changes.reviewedAt).toBeDefined();
      expect(changes.reviewedBy).toBeDefined();
    });
  });

  describe("Permission Rules table", () => {
    it("should have the correct columns", () => {
      expect(permissionRules.id).toBeDefined();
      expect(permissionRules.repoId).toBeDefined();
      expect(permissionRules.agentId).toBeDefined();
      expect(permissionRules.ruleType).toBeDefined();
      expect(permissionRules.pattern).toBeDefined();
      expect(permissionRules.conditions).toBeDefined();
    });
  });

  describe("Audit Events table", () => {
    it("should have the correct columns", () => {
      expect(auditEvents.id).toBeDefined();
      expect(auditEvents.repoId).toBeDefined();
      expect(auditEvents.agentId).toBeDefined();
      expect(auditEvents.action).toBeDefined();
      expect(auditEvents.metadata).toBeDefined();
      expect(auditEvents.timestamp).toBeDefined();
    });
  });

  describe("Enums", () => {
    it("should have correct agent types", () => {
      expect(agentTypeEnum.enumValues).toEqual([
        "openclaw",
        "claude_code",
        "cursor",
        "generic",
      ]);
    });

    it("should have correct auth providers", () => {
      expect(authProviderEnum.enumValues).toEqual([
        "github_oauth",
        "email",
        "api_key",
      ]);
    });

    it("should have correct change statuses", () => {
      expect(changeStatusEnum.enumValues).toEqual([
        "pending",
        "approved",
        "rejected",
        "merged",
        "rolled_back",
      ]);
    });

    it("should have correct risk levels", () => {
      expect(riskLevelEnum.enumValues).toEqual([
        "low",
        "medium",
        "high",
        "critical",
      ]);
    });

    it("should have correct rule types", () => {
      expect(ruleTypeEnum.enumValues).toEqual([
        "allow_path",
        "deny_path",
        "require_approval",
        "auto_merge",
      ]);
    });
  });
});
