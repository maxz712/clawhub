import { ClawForgeClient, ClawForgeError } from "./client.js";
import type {
  DecisionAssessment,
  InlineComment,
  SubmitReviewParams,
} from "./client.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

function formatError(err: unknown): ToolResult {
  if (err instanceof ClawForgeError) {
    return {
      content: `Error (${err.status}): ${err.message}`,
      isError: true,
    };
  }
  if (err instanceof Error) {
    return {
      content: `Error: ${err.message}`,
      isError: true,
    };
  }
  return {
    content: `Unknown error: ${String(err)}`,
    isError: true,
  };
}

export interface RegisterParams {
  api_url: string;
  agent_name: string;
  agent_type?: string;
}

export interface PendingParams {
  repo?: string;
}

export interface ChangeDetailParams {
  change_id: string;
}

export interface SubmitReviewToolParams {
  change_id: string;
  verdict: string;
  summary: string;
  decisions: DecisionAssessment[];
  uncertainty?: string[];
  verified_scope: string[];
  unverified_scope?: string[];
  comments?: InlineComment[];
}

export type ToolHandlers = ReturnType<typeof createTools>;

export function createRegisterTool() {
  return {
    clawforge_register: async (
      params: RegisterParams,
    ): Promise<ToolResult> => {
      try {
        if (!params.api_url || !params.agent_name) {
          return {
            content: "Error: api_url and agent_name are required.",
            isError: true,
          };
        }

        const result = await ClawForgeClient.registerAgent(
          params.api_url,
          params.agent_name,
          params.agent_type,
        );

        const lines = [
          "Agent registered successfully!",
          "",
          `Agent ID: ${result.agent.id}`,
          `Agent Name: ${result.agent.name}`,
          `Agent Type: ${result.agent.type}`,
          `Token: ${result.token}`,
          "",
          "Use this token for all API calls and git operations:",
          `  Authorization: Bearer ${result.token}`,
          `  Git: git clone http://agent-token:${result.token}@<host>/${result.agent.name}/repo.git`,
        ];

        if (result.claim_token) {
          lines.push(
            "",
            "Claim token (give to your human operator for oversight):",
            `  ${result.claim_token}`,
          );
        }

        lines.push(
          "",
          "Set these environment variables to use the skill:",
          `  CLAWFORGE_API_URL="${params.api_url}"`,
          `  CLAWFORGE_TOKEN="${result.token}"`,
        );

        return { content: lines.join("\n") };
      } catch (err) {
        return formatError(err);
      }
    },
  };
}

export function createTools(client: ClawForgeClient) {
  return {
    clawforge_pending: async (
      params: PendingParams,
    ): Promise<ToolResult> => {
      try {
        const changes = await client.listPendingChanges(params.repo);

        if (changes.length === 0) {
          return {
            content: "No pending changes assigned to you for review.",
          };
        }

        const lines = changes.map(
          (c) =>
            `  [${c.risk_level}] ${c.id}\n` +
            `    Repo: ${c.repo_owner}/${c.repo_name}\n` +
            `    Branch: ${c.branch}\n` +
            `    Intent: ${c.intent}\n` +
            `    Author: ${c.author_type} (${c.author_id})\n` +
            `    Files: ${c.commit_count} commit(s), scope: ${c.scope.join(", ") || "unknown"}\n` +
            `    Conflicts: ${c.has_conflicts ? "YES" : "no"}` +
            (c.escalated ? `\n    ESCALATED: ${c.escalation_reason}` : ""),
        );

        return {
          content: `Pending changes for review (${changes.length}):\n\n${lines.join("\n\n")}`,
        };
      } catch (err) {
        return formatError(err);
      }
    },

    clawforge_change_detail: async (
      params: ChangeDetailParams,
    ): Promise<ToolResult> => {
      try {
        const detail = await client.getChangeDetail(params.change_id);

        const decisionsText =
          detail.decisions.length > 0
            ? detail.decisions
                .map((d, i) => `  ${i + 1}. ${d.description}`)
                .join("\n")
            : "  (none)";

        const focusText =
          detail.review_focus.length > 0
            ? detail.review_focus
                .map(
                  (f) =>
                    `  ${f.path}${f.lines ? `:${f.lines}` : ""} — ${f.description}`,
                )
                .join("\n")
            : "  (none)";

        const reviewCommentsText =
          detail.review_comments.length > 0
            ? detail.review_comments
                .map((c) => `  ${c.path}:${c.line} — ${c.body}`)
                .join("\n")
            : "  (none)";

        const existingReviews =
          detail.reviews.length > 0
            ? detail.reviews
                .map(
                  (r) =>
                    `  [${r.verdict}] by ${r.reviewer_type} ${r.reviewer_id} — ${r.summary}`,
                )
                .join("\n")
            : "  (none yet)";

        const sections = [
          `Change: ${detail.id}`,
          `Status: ${detail.status}`,
          `Repo: ${detail.repo_owner}/${detail.repo_name}`,
          `Branch: ${detail.branch}`,
          `Author: ${detail.author_type} (${detail.author_id})`,
          `Risk: ${detail.risk_level}`,
          `Conflicts: ${detail.has_conflicts ? "YES — trial merge failed" : "no"}`,
          detail.escalated
            ? `ESCALATED: ${detail.escalation_reason}`
            : null,
          ``,
          `Intent:`,
          `  ${detail.intent}`,
          ``,
          `Scope: ${detail.scope.join(", ") || "(not specified)"}`,
          `Refs: ${detail.refs.join(", ") || "(none)"}`,
          ``,
          `Decisions (from author):`,
          decisionsText,
          ``,
          `Review Focus (from author):`,
          focusText,
          ``,
          `Inline REVIEW Comments:`,
          reviewCommentsText,
          ``,
          `Existing Reviews:`,
          existingReviews,
          ``,
          `--- Diff ---`,
          detail.diff,
        ];

        return {
          content: sections.filter((s) => s !== null).join("\n"),
        };
      } catch (err) {
        return formatError(err);
      }
    },

    clawforge_submit_review: async (
      params: SubmitReviewToolParams,
    ): Promise<ToolResult> => {
      try {
        const validVerdicts = ["approve", "request_changes", "comment"];
        if (!validVerdicts.includes(params.verdict)) {
          return {
            content: `Error: verdict must be one of: ${validVerdicts.join(", ")}. Got: ${params.verdict}`,
            isError: true,
          };
        }

        if (!params.decisions || params.decisions.length === 0) {
          return {
            content:
              "Error: decisions array is required and must contain at least one decision assessment.",
            isError: true,
          };
        }

        if (!params.verified_scope || params.verified_scope.length === 0) {
          return {
            content:
              "Error: verified_scope is required — list the files/paths you examined.",
            isError: true,
          };
        }

        const reviewParams: SubmitReviewParams = {
          verdict: params.verdict as "approve" | "request_changes" | "comment",
          summary: params.summary,
          decisions: params.decisions,
          uncertainty: params.uncertainty,
          verified_scope: params.verified_scope,
          unverified_scope: params.unverified_scope,
          comments: params.comments,
        };

        const result = await client.submitReview(
          params.change_id,
          reviewParams,
        );

        const uncertaintyNote =
          params.uncertainty && params.uncertainty.length > 0
            ? `\n  Uncertainty flags: ${params.uncertainty.length} (will trigger escalation to human)`
            : "";

        return {
          content: [
            `Review submitted successfully.`,
            `  Review ID: ${result.id}`,
            `  Change: ${result.change_id}`,
            `  Verdict: ${params.verdict}`,
            `  Summary: ${params.summary}`,
            `  Decisions assessed: ${params.decisions.length}`,
            `  Verified scope: ${params.verified_scope.join(", ")}`,
            params.unverified_scope && params.unverified_scope.length > 0
              ? `  Unverified scope: ${params.unverified_scope.join(", ")}`
              : null,
            params.comments && params.comments.length > 0
              ? `  Inline comments: ${params.comments.length}`
              : null,
            uncertaintyNote || null,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      } catch (err) {
        return formatError(err);
      }
    },
  };
}
