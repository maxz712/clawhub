import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { ApiClient } from "../lib/api.js";

function parseRepo(): { ns: string; repo: string } {
  const remote = execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim();
  const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) { console.error(chalk.red("cannot parse remote")); process.exit(1); }
  return { ns: m[1], repo: m[2] };
}

interface Issue { id: string; number: number; title: string; status: string; assignedAgentId: string | null }

export function registerIssueCommands(program: Command) {
  const g = program.command("issue").description("Issue queue");

  g.command("list")
    .description("List issues")
    .option("--status <s>", "open|closed", "open")
    .option("--assigned <who>", "me")
    .action(async opts => {
      const { ns, repo } = parseRepo();
      const q = new URLSearchParams();
      if (opts.status) q.set("status", opts.status);
      if (opts.assigned) q.set("assigned", opts.assigned);
      const client = new ApiClient();
      const { issues } = await client.request<{ issues: Issue[] }>("GET", `/api/v1/repos/${ns}/${repo}/issues?${q}`);
      for (const i of issues) {
        console.log(`${chalk.cyan("#" + i.number)} ${chalk.gray(i.status.padEnd(6))} ${i.title}`);
      }
    });

  g.command("create <title>")
    .description("Create an issue")
    .option("-b, --body <text>")
    .option("-a, --assign <agentId>")
    .action(async (title, opts) => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const { issue } = await client.request<{ issue: Issue }>("POST", `/api/v1/repos/${ns}/${repo}/issues`, { body: { title, body: opts.body, assignedAgentId: opts.assign } });
      console.log(chalk.green(`✓ #${issue.number} created`));
    });

  g.command("close <num>")
    .description("Close an issue")
    .action(async num => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      await client.request("PATCH", `/api/v1/repos/${ns}/${repo}/issues/${num}`, { body: { status: "closed" } });
      console.log(chalk.green(`✓ #${num} closed`));
    });
}
