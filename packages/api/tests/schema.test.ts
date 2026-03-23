import { describe, it, expect } from "vitest";
import {
  users,
  agents,
  repositories,
  changes,
  reviews,
  permissionRules,
  auditEvents,
  humanSummaries,
  agentTypeEnum,
  authProviderEnum,
  changeStatusEnum,
  riskLevelEnum,
  ruleTypeEnum,
  actorTypeEnum,
  reviewVerdictEnum,
  summaryRecommendationEnum,
  summaryConfidenceEnum,
} from "../src/models/schema.js";

describe("Database Schema", () => {
  describe("Users table", () => {
    it("should have the correct columns", () => {
      expect(users.id).toBeDefined();
      expect(users.email).toBeDefined();
      expect(users.passwordHash).toBeDefined();
      expect(users.authProvider).toBeDefined();
      expect(users.maxRepos).toBeDefined();
      expect(users.defaultEscalation).toBeDefined();
      expect(users.createdAt).toBeDefined();
    });
  });

  describe("Agents table", () => {
    it("should have the correct columns", () => {
      expect(agents.id).toBeDefined();
      expect(agents.name).toBeDefined();
      expect(agents.type).toBeDefined();
      expect(agents.ownerId).toBeDefined();
      expect(agents.claimToken).toBeDefined();
      expect(agents.gitAuthor).toBeDefined();
      expect(agents.canCreateRepos).toBeDefined();
      expect(agents.canReview).toBeDefined();
      expect(agents.maxRepos).toBeDefined();
      expect(agents.reviewStats).toBeDefined();
      expect(agents.metadata).toBeDefined();
      expect(agents.createdAt).toBeDefined();
    });

    it("should not have publicKey column", () => {
      expect((agents as any).publicKey).toBeUndefined();
    });
  });

  describe("Repositories table", () => {
    it("should have the correct columns", () => {
      expect(repositories.id).toBeDefined();
      expect(repositories.name).toBeDefined();
      expect(repositories.ownerId).toBeDefined();
      expect(repositories.ownerAgentId).toBeDefined();
      expect(repositories.createdBy).toBeDefined();
      expect(repositories.gitPath).toBeDefined();
      expect(repositories.description).toBeDefined();
      expect(repositories.defaultBranch).toBeDefined();
      expect(repositories.isPublic).toBeDefined();
      expect(repositories.mergePolicy).toBeDefined();
      expect(repositories.reviewerConfig).toBeDefined();
      expect(repositories.escalationPolicy).toBeDefined();
      expect(repositories.humanSummaryConfig).toBeDefined();
      expect(repositories.createdAt).toBeDefined();
    });
  });

  describe("Changes table", () => {
    it("should have the correct columns", () => {
      expect(changes.id).toBeDefined();
      expect(changes.repoId).toBeDefined();
      expect(changes.authorId).toBeDefined();
      expect(changes.authorType).toBeDefined();
      expect(changes.branch).toBeDefined();
      expect(changes.intent).toBeDefined();
      expect(changes.riskLevel).toBeDefined();
      expect(changes.scope).toBeDefined();
      expect(changes.decisions).toBeDefined();
      expect(changes.reviewFocus).toBeDefined();
      expect(changes.reviewComments).toBeDefined();
      expect(changes.refs).toBeDefined();
      expect(changes.commitCount).toBeDefined();
      expect(changes.hasConflicts).toBeDefined();
      expect(changes.status).toBeDefined();
      expect(changes.escalated).toBeDefined();
      expect(changes.escalationReason).toBeDefined();
      expect(changes.humanSummaryId).toBeDefined();
      expect(changes.createdAt).toBeDefined();
      expect(changes.updatedAt).toBeDefined();
    });

    it("should not have v1 columns", () => {
      expect((changes as any).agentId).toBeUndefined();
      expect((changes as any).description).toBeUndefined();
      expect((changes as any).diffSummary).toBeUndefined();
      expect((changes as any).semanticDiff).toBeUndefined();
      expect((changes as any).reviewedAt).toBeUndefined();
      expect((changes as any).reviewedBy).toBeUndefined();
    });
  });

  describe("Reviews table", () => {
    it("should have the correct columns", () => {
      expect(reviews.id).toBeDefined();
      expect(reviews.changeId).toBeDefined();
      expect(reviews.reviewerId).toBeDefined();
      expect(reviews.reviewerType).toBeDefined();
      expect(reviews.verdict).toBeDefined();
      expect(reviews.summary).toBeDefined();
      expect(reviews.decisions).toBeDefined();
      expect(reviews.uncertainty).toBeDefined();
      expect(reviews.verifiedScope).toBeDefined();
      expect(reviews.unverifiedScope).toBeDefined();
      expect(reviews.comments).toBeDefined();
      expect(reviews.createdAt).toBeDefined();
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
      expect(auditEvents.actorId).toBeDefined();
      expect(auditEvents.actorType).toBeDefined();
      expect(auditEvents.action).toBeDefined();
      expect(auditEvents.metadata).toBeDefined();
      expect(auditEvents.timestamp).toBeDefined();
    });

    it("should not have v1 agentId column", () => {
      expect((auditEvents as any).agentId).toBeUndefined();
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
        "google_oauth",
        "email",
        "api_key",
      ]);
    });

    it("should have correct change statuses", () => {
      expect(changeStatusEnum.enumValues).toEqual([
        "pending_review",
        "approved",
        "changes_requested",
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
        "allow_review",
        "deny_review",
      ]);
    });

    it("should have correct actor types", () => {
      expect(actorTypeEnum.enumValues).toEqual(["agent", "human"]);
    });

    it("should have correct review verdicts", () => {
      expect(reviewVerdictEnum.enumValues).toEqual([
        "approve",
        "request_changes",
        "comment",
      ]);
    });

    it("should have correct summary recommendations", () => {
      expect(summaryRecommendationEnum.enumValues).toEqual([
        "approve",
        "reject",
        "needs_discussion",
      ]);
    });

    it("should have correct summary confidence levels", () => {
      expect(summaryConfidenceEnum.enumValues).toEqual([
        "high",
        "medium",
        "low",
      ]);
    });
  });

  describe("Human Summaries table", () => {
    it("should have the correct columns", () => {
      expect(humanSummaries.id).toBeDefined();
      expect(humanSummaries.changeId).toBeDefined();
      expect(humanSummaries.submittedBy).toBeDefined();
      expect(humanSummaries.headline).toBeDefined();
      expect(humanSummaries.whatHappened).toBeDefined();
      expect(humanSummaries.whyCare).toBeDefined();
      expect(humanSummaries.keyDecisions).toBeDefined();
      expect(humanSummaries.uncertainty).toBeDefined();
      expect(humanSummaries.recommendation).toBeDefined();
      expect(humanSummaries.confidence).toBeDefined();
      expect(humanSummaries.submittedAt).toBeDefined();
    });

    it("should not have LLM-related columns", () => {
      expect((humanSummaries as any).modelUsed).toBeUndefined();
      expect((humanSummaries as any).tokenCost).toBeUndefined();
      expect((humanSummaries as any).generatedAt).toBeUndefined();
    });
  });
});
