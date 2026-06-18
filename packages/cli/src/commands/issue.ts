import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { parseRepo } from "../lib/repo.js";

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
      if (!issues.length) { console.log(chalk.gray(`(no ${opts.status ?? "open"} issues)`)); return; }
      for (const i of issues) {
        console.log(`${chalk.cyan("#" + i.number)} ${chalk.gray(i.status.padEnd(6))} ${i.title}`);
      }
    });

  g.command("create [title]")
    .description("Create an issue (title can be positional or via -t/--title)")
    .option("-t, --title <title>", "issue title (alternative to the positional <title>)")
    .option("-b, --body <text>")
    .option("-a, --assign <agentId>")
    .action(async (titleArg, opts) => {
      const title = titleArg ?? opts.title;
      if (!title) {
        console.error(chalk.red("✗ a title is required — pass it positionally or with -t/--title."));
        console.error(chalk.gray("  e.g. ") + chalk.cyan('ch issue create "Fix the login bug"') + chalk.gray(" or ") + chalk.cyan('ch issue create -t "Fix the login bug"'));
        process.exit(1);
      }
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
