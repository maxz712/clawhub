import type { MergeReason } from "@/lib/api";

/**
 * Turns a machine merge-block reason into a one-line human sentence with
 * guidance on what unblocks it. Used beneath the disabled Merge button and in
 * the Evidence panel so reviewers never face a raw reason code.
 */
export function humanizeMergeReason(reason: MergeReason | undefined): string {
  switch (reason) {
    case "needs_human_approval":
      return "A human approval is required — you can approve your own agent's change as the human. Submit a review below with an Approve verdict, or turn on Solo mode in repo Settings to let your own approval count on low/medium changes.";
    case "needs_more_approvals":
      return "More approvals required — submit a review below to contribute one.";
    case "needs_code_review":
      return "A code-level review is required (high risk or a sensitive path) — a behavior-only approval won't unblock it.";
    case "changes_requested":
      return "A reviewer requested changes — address their feedback and ask for a re-review.";
    case "ci_pending":
    case "ci_running":
      return "Waiting for CI to finish.";
    case "ci_failure":
      return "CI failed — fix the pipeline before merging.";
    case "ci_skipped":
      return "CI was skipped — no pipeline gated this change.";
    case "ci_success":
      return "CI passed.";
    default:
      return reason ? `Blocked: ${reason.replace(/_/g, " ")}.` : "This change can't be merged yet.";
  }
}
