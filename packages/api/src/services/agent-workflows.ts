/**
 * v2 agents-ux: WORKFLOWS are just prompt instructions, and the common ones
 * have slash flags. A standing agent's task (or a run-now override) that
 * starts with "/dev", "/review", … expands SERVER-SIDE at dispatch into the
 * full instruction preset (+ the operator's trailing text as extra focus),
 * and pins the matching harness mode. One expansion point covers scheduled,
 * triggered, and manual runs identically — workflows are managed the same
 * way regardless of how a run started, and every run is auditable as a
 * ci_runs row either way.
 */

export interface SlashWorkflow {
  label: string;
  mode: "develop" | "worker" | "verify" | "review" | "triage" | "reflect";
  instructions: string;
}

export const SLASH_WORKFLOWS: Record<string, SlashWorkflow> = {
  "/dev": {
    label: "Develop",
    mode: "develop",
    instructions:
      "Build the most valuable open issue (assigned to you or unassigned) end-to-end with tests. " +
      "Run the app and verify your work behaves — click through the changed surface in the browser. " +
      "Open ONE Change with clear trailers and screenshot evidence.",
  },
  "/review": {
    label: "Review",
    mode: "review",
    instructions:
      "Review the open Changes you did not author. Read each diff with its focus flags, judge correctness " +
      "and intent-vs-diff honestly, and submit a verdict with specific findings. Never rubber-stamp.",
  },
  "/verify": {
    label: "Verify",
    mode: "verify",
    instructions:
      "Verify the Change you were dispatched for end-to-end: boot the app, exercise the changed surface in " +
      "a real browser, attach screenshot evidence, and submit an attestation with per-check results.",
  },
  "/scout": {
    label: "Scout",
    mode: "worker",
    instructions:
      "Scan the repo — code, docs, tests, TODOs, recent Changes — and file exactly ONE well-scoped, " +
      "high-value issue via the ClawHub API, with context and acceptance criteria. Do not push code.",
  },
  "/triage": {
    label: "Triage",
    mode: "triage",
    instructions:
      "Triage open issues: label them, set priorities, deduplicate, and route each to the right agent or human. " +
      "Comment your reasoning on anything you re-prioritize.",
  },
  "/loop": {
    label: "Full loop",
    mode: "develop",
    instructions:
      "You own this repo's improvement loop. Each run: " +
      "1) If there are no open issues, scan the repo and file ONE well-scoped, high-value issue. " +
      "2) Pick the most valuable open issue, implement it end-to-end with tests. " +
      "3) Run the app and verify your work behaves in the browser. " +
      "4) Open ONE Change with clear trailers and screenshot evidence. " +
      "5) Review any open Changes you did not author and submit an honest verdict.",
  },
};

/**
 * Expand a task that starts with a slash flag. Unknown flags and plain prose
 * pass through untouched. Trailing text after the flag becomes operator focus
 * appended to the preset ("/dev focus on dark mode" → dev preset + note).
 */
export function expandWorkflowTask(raw: string | null | undefined): { task: string; mode?: SlashWorkflow["mode"] } {
  const t = (raw ?? "").trim();
  const m = t.match(/^(\/[a-z-]+)\b([\s\S]*)$/i);
  if (!m) return { task: t };
  const wf = SLASH_WORKFLOWS[m[1].toLowerCase()];
  if (!wf) return { task: t };
  const extra = m[2].trim();
  return {
    task: wf.instructions + (extra ? `\n\nOperator focus for this run: ${extra}` : ""),
    mode: wf.mode,
  };
}
