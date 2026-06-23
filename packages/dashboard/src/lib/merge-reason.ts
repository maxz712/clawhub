import type { MergeReason } from "@/lib/api";

/**
 * Context that decides whether self-approval is the EXPECTED path (a solo,
 * USER-namespace repo where the developer owns and reviews their own work —
 * whether they or their agent authored it) or whether an INDEPENDENT approver is
 * required (an org repo, or a teammate reviewing a colleague's change). `solo` is
 * true only when both:
 *   - the repo lives in a USER namespace (not an org), and
 *   - the viewer is the change author / repo owner (not a non-author teammate).
 * When `solo` is false we must NOT tell the viewer that self-approval is fine.
 */
export interface MergeReasonContext {
  /** true → solo USER-namespace repo, viewer is the author. */
  solo: boolean;
}

/**
 * Turns a machine merge-block reason into a one-line human sentence with
 * guidance on what unblocks it. Used beneath the disabled Merge button and in
 * the Evidence panel so reviewers never face a raw reason code.
 *
 * Pass `ctx` to branch the approval copy: a solo USER repo author gets the
 * "self-approving your own work is expected" framing; an org repo or a teammate
 * gets the stricter "needs an independent human reviewer" framing.
 */
export function humanizeMergeReason(reason: MergeReason | undefined, ctx?: MergeReasonContext): string {
  const solo = ctx?.solo ?? true;
  switch (reason) {
    case "needs_human_approval":
      return solo
        ? "Submit an Approve review below to unblock — self-approving your own work is expected for solo repos."
        : "This change needs an approving CODE review from a human other than the author.";
    case "needs_more_approvals":
      return solo
        ? "More approvals required — submit an Approve review below to unblock. Self-approving your own work is expected for solo repos."
        : "More approvals required — this change needs an approving review from a human other than the author.";
    case "needs_independent_approver":
      return "An approving CODE review is required from a human other than the change's author — the author's own owner can't be the independent sign-off.";
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
