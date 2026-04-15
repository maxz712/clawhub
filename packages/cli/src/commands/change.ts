import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { ApiClient } from "../lib/api.js";

interface Change {
  id: string;
  branch: string;
  intent: string;
  risk: string;
  status: string;
  hasConflicts: boolean;
  ciStatus: string;
  updatedAt: string;
}

function parseRepo(): { ns: string; repo: string } {
  const remote = execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim();
  const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) { console.error(chalk.red("cannot parse remote origin URL")); process.exit(1); }
  return { ns: m[1], repo: m[2] };
}

export function registerChangeCommands(program: Command) {
  const g = program.command("change").description("Work with changes");

  g.command("list")
    .description("List changes in the current repo")
    .action(async () => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const { changes } = await client.request<{ changes: Change[] }>("GET", `/api/v1/repos/${ns}/${repo}/changes`);
      for (const c of changes) {
        const risk = c.risk === "critical" ? chalk.redBright(c.risk) : c.risk === "high" ? chalk.red(c.risk) : c.risk === "medium" ? chalk.yellow(c.risk) : chalk.green(c.risk);
        console.log(`${chalk.cyan(c.id.slice(0, 8))} ${chalk.gray(c.branch.padEnd(30))} ${risk.padEnd(20)} ${c.status} ci:${c.ciStatus}`);
        console.log(`  ${c.intent}`);
      }
    });

  g.command("show <id>")
    .description("Show change metadata")
    .action(async id => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const { change, mergeable } = await client.request<{ change: Change & { scope: string[]; reviewFocus: Array<{ path: string; startLine: number; endLine: number; note?: string }> }; mergeable: { mergeable: boolean; reason?: string } }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}`);
      console.log(chalk.bold(change.intent));
      console.log(`${chalk.gray("branch:")}  ${change.branch}`);
      console.log(`${chalk.gray("risk:")}    ${change.risk}`);
      console.log(`${chalk.gray("status:")}  ${change.status}`);
      console.log(`${chalk.gray("ci:")}      ${change.ciStatus}`);
      console.log(`${chalk.gray("scope:")}   ${change.scope.join(", ")}`);
      if (change.reviewFocus.length) {
        console.log(chalk.gray("review-focus:"));
        for (const f of change.reviewFocus) console.log(`  ${f.path}:${f.startLine}-${f.endLine}${f.note ? " — " + f.note : ""}`);
      }
      console.log(`${chalk.gray("merge:")}   ${mergeable.mergeable ? chalk.green("ready") : chalk.yellow(mergeable.reason ?? "blocked")}`);
    });

  g.command("diff <id>")
    .description("Show focused diff (use --full for raw diff)")
    .option("-f, --full", "show the full diff")
    .action(async (id, opts) => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const mode = opts.full ? "full" : "focused";
      const { diff } = await client.request<{ diff: string }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}/diff?mode=${mode}`);
      console.log(diff || chalk.gray("(empty)"));
    });

  g.command("review <id>")
    .description("Submit a review")
    .requiredOption("-v, --verdict <verdict>", "approve|request_changes|comment")
    .option("-s, --summary <text>")
    .action(async (id, opts) => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      await client.request("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/reviews`, { body: { verdict: opts.verdict, summary: opts.summary } });
      console.log(chalk.green("✓ review submitted"));
    });

  g.command("merge <id>")
    .description("Merge a change")
    .action(async id => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      await client.request("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/merge`);
      console.log(chalk.green("✓ merged"));
    });
}
