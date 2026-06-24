import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient, ApiError } from "../lib/api.js";
import { parseRepo, resolveChangeId } from "../lib/repo.js";

interface Reviewer { kind: "agent" | "human"; id: string }

interface Change {
  id: string;
  branch: string;
  intent: string;
  risk: string;
  status: string;
  hasConflicts: boolean;
  ciStatus: string;
  computedRisk?: string;
  riskReasons?: string[];
  requestedReviewers?: Reviewer[];
  updatedAt: string;
}

interface Collaborator { kind: "agent" | "human"; agentId?: string | null; name?: string | null; agentName?: string | null; role: string }

// A change pushed to refs/for/<branch> is keyed internally as
// `magic/<target>/<head12>`. That synthetic ref is an implementation detail
// (ref-per-change), not a branch the human typed — show the branch the change
// TARGETS instead so `ch change list` reads naturally.
const MAGIC_BRANCH = /^magic\/(.+)\/[0-9a-f]{12}$/;
function displayBranch(branch: string): string {
  const m = branch.match(MAGIC_BRANCH);
  return m ? `→ ${m[1]}` : branch;
}

// Colorize a risk level after padding the plain string, so the ANSI escape
// bytes don't throw off column alignment (padEnd counts raw bytes).
function colorRisk(risk: string, width = 0): string {
  const padded = width ? risk.padEnd(width) : risk;
  if (risk === "critical") return chalk.redBright(padded);
  if (risk === "high") return chalk.red(padded);
  if (risk === "medium") return chalk.yellow(padded);
  return chalk.green(padded);
}

// Map a machine merge-reason code to a one-line human remedy. Returns null
// when the reason is unknown (we still print the raw code as a fallback).
function mergeRemedy(reason: string, id: string): string | null {
  switch (reason) {
    case "needs_human_approval":
    case "needs_more_approvals":
      return `→ approve: ${chalk.cyan(`ch change review ${id} -v approve`)}, then ${chalk.cyan(`ch change merge ${id}`)}\n`
        + `    — if you're solo, claim this agent to your account and approve as yourself, or enable Solo mode: ${chalk.cyan("ch repo solo-mode")}`;
    case "needs_code_review":
      return `→ a human must approve after reading the code: ${chalk.cyan(`ch change review ${id} -v approve --basis code`)} (behavior-only is not enough at this risk level)`;
    case "needs_independent_approver":
      return `→ a human OTHER than the change author must approve the code (separation of duties).`;
    case "changes_requested":
      return `→ a reviewer requested changes — address the feedback, push again, and ask for re-review.`;
    case "has_conflicts":
      return `→ merge conflicts — rebase your branch on the default branch and push again.`;
    default:
      if (reason.startsWith("ci_")) {
        if (reason === "ci_failure") return `→ CI failed — fix the pipeline (${chalk.cyan(`ch ci runs ${id}`)}) and push again before merging.`;
        return `→ waiting on CI (${chalk.cyan(`ch ci runs ${id}`)}) — merge once it passes.`;
      }
      return null;
  }
}

export function registerChangeCommands(program: Command) {
  const g = program.command("change").description("Work with changes (run inside a ClawHub repo)");

  g.command("list")
    .description("List changes in the current repo")
    .action(async () => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const { changes } = await client.request<{ changes: Change[] }>("GET", `/api/v1/repos/${ns}/${repo}/changes`);
      if (!changes.length) {
        console.log(chalk.gray("(no changes)"));
        console.log(chalk.gray("  just pushed? a Change can take a few seconds to appear while the push is processed — re-run shortly."));
        return;
      }
      for (const c of changes) {
        const risk = colorRisk(c.risk, 8);
        console.log(`${chalk.cyan(c.id.slice(0, 8))} ${chalk.gray(displayBranch(c.branch).padEnd(30))} ${risk} ${c.status.padEnd(18)} ci:${c.ciStatus}`);
        console.log(`  ${c.intent}`);
      }
    });

  g.command("show <id>")
    .description("Show change metadata (accepts the 8-char ID from `ch change list`)")
    .action(async idArg => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const id = await resolveChangeId(client, ns, repo, idArg);
      const { change, mergeable } = await client.request<{ change: Change & { scope: string[]; reviewFocus: Array<{ path: string; startLine: number; endLine: number; note?: string }> }; mergeable: { mergeable: boolean; reason?: string } }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}`);
      console.log(chalk.bold(change.intent));
      console.log(`${chalk.gray("id:")}      ${change.id}`);
      console.log(`${chalk.gray("branch:")}  ${displayBranch(change.branch)}`);
      console.log(`${chalk.gray("risk:")}    ${colorRisk(change.computedRisk ?? change.risk)}${change.computedRisk && change.computedRisk !== change.risk ? chalk.gray(` (declared ${change.risk})`) : ""}`);
      if (change.riskReasons?.length) {
        for (const r of change.riskReasons) console.log(`  ${chalk.gray("·")} ${chalk.gray(r)}`);
      }
      console.log(`${chalk.gray("status:")}  ${change.status}`);
      console.log(`${chalk.gray("ci:")}      ${change.ciStatus}`);
      console.log(`${chalk.gray("scope:")}   ${change.scope.join(", ")}`);
      if (change.requestedReviewers?.length) {
        console.log(`${chalk.gray("reviewers:")} ${change.requestedReviewers.map(r => (r.kind === "agent" ? "@" : "") + r.id.slice(0, 8)).join(", ")}`);
      }
      if (change.reviewFocus.length) {
        console.log(chalk.gray("review-focus:"));
        for (const f of change.reviewFocus) console.log(`  ${f.path}:${f.startLine}-${f.endLine}${f.note ? " — " + f.note : ""}`);
      }
      if (mergeable.mergeable) {
        console.log(`${chalk.gray("merge:")}   ${chalk.green("ready")}`);
        console.log(`  ${chalk.cyan(`ch change merge ${change.id.slice(0, 8)}`)} to ship it.`);
      } else {
        const reason = mergeable.reason ?? "blocked";
        console.log(`${chalk.gray("merge:")}   ${chalk.yellow(reason)}`);
        const remedy = mergeRemedy(reason, change.id.slice(0, 8));
        if (remedy) console.log(`  ${remedy}`);
      }
    });

  g.command("diff <id>")
    .description("Show focused diff (use --full for raw diff; accepts the 8-char ID)")
    .option("-f, --full", "show the full diff")
    .action(async (idArg, opts) => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const id = await resolveChangeId(client, ns, repo, idArg);
      const mode = opts.full ? "full" : "focused";
      const { diff } = await client.request<{ diff: string }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}/diff?mode=${mode}`);
      console.log(diff || chalk.gray("(empty)"));
    });

  g.command("review <id>")
    .description("Submit a review (accepts the 8-char ID). Use --merge to approve AND merge in one go.")
    .requiredOption("-v, --verdict <verdict>", "approve|request_changes|comment")
    .option("-b, --basis <basis>", "behavior|code|both — what your approval rests on; code is required to satisfy the gate at high risk", "behavior")
    .option("-s, --summary <text>")
    .option("-m, --merge", "after an approve, merge immediately (needs write access)")
    .option("--method <method>", "merge method when --merge: merge|squash|rebase", "merge")
    .action(async (idArg, opts) => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const id = await resolveChangeId(client, ns, repo, idArg);
      await client.request("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/reviews`, { body: { verdict: opts.verdict, basis: opts.basis, summary: opts.summary } });
      console.log(chalk.green("✓ review submitted"));
      if (!opts.merge) return;
      if (opts.verdict !== "approve") {
        console.log(chalk.yellow("  --merge ignored — it only applies to an approve verdict."));
        return;
      }
      // Approve-and-merge: the approval is recorded, so try the merge now. If the
      // gate still blocks (e.g. CI pending, another approver needed), say WHY
      // instead of failing silently — the review still landed.
      try {
        await client.request("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/merge`, { body: { method: opts.method }, throwOnError: true });
        console.log(chalk.green("✓ merged"));
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : (e as Error).message;
        console.log(chalk.yellow(`  approved, but not merged: ${msg}`));
      }
    });

  g.command("request-review <id>")
    .alias("request")
    .description("Ask an agent to review (dispatches it if it's a standing reviewer)")
    .option("-a, --agent <name...>", "reviewer agent name(s) — must be a repo collaborator")
    .action(async (idArg, opts) => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const id = await resolveChangeId(client, ns, repo, idArg);
      const names: string[] = opts.agent ?? [];
      if (!names.length) {
        console.error(chalk.red("✗ pass at least one reviewer with --agent <name>"));
        console.error(chalk.gray("  candidates are the repo's reviewer/writer collaborator agents (repo Settings → Collaborators)."));
        process.exit(1);
      }
      const { collaborators } = await client.request<{ collaborators: Collaborator[] }>("GET", `/api/v1/repos/${ns}/${repo}/collaborators`);
      const byName = new Map(collaborators.filter(c => c.kind === "agent" && c.agentId).map(c => [(c.name ?? c.agentName) as string, c.agentId as string]));
      const { change } = await client.request<{ change: Change }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}`);
      const next: Reviewer[] = [...(change.requestedReviewers ?? [])];
      for (const name of names) {
        const agentId = byName.get(name);
        if (!agentId) {
          console.error(chalk.red(`✗ "${name}" is not a collaborator on ${ns}/${repo}`));
          console.error(chalk.gray("  grant it as a reviewer first in the dashboard: repo Settings → Collaborators."));
          process.exit(1);
        }
        if (!next.some(r => r.kind === "agent" && r.id === agentId)) next.push({ kind: "agent", id: agentId });
      }
      await client.request("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/reviewers`, { body: { reviewers: next } });
      console.log(chalk.green(`✓ requested review from ${names.map(n => "@" + n).join(", ")}`));
      console.log(chalk.gray("  a standing reviewer agent is dispatched now; others are notified."));
    });

  g.command("merge <id>")
    .description("Merge a change (accepts the 8-char ID)")
    .option("--method <method>", "merge method: merge|squash|rebase", "merge")
    .action(async (idArg, opts) => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const id = await resolveChangeId(client, ns, repo, idArg);
      await client.request("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/merge`, { body: { method: opts.method } });
      console.log(chalk.green("✓ merged"));
    });
}
