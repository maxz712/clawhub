import { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../lib/api-client.js";

export function registerReviewCommands(program: Command): void {
  program
    .command("review <id>")
    .description("Submit a review for a change (standalone shortcut)")
    .requiredOption("--repo <id>", "Repository ID")
    .option("--approve", "Approve the change")
    .option("--reject <reason>", "Reject the change with a reason")
    .option("--comment <text>", "Add a comment")
    .action(async (id: string, opts: { repo: string; approve?: boolean; reject?: string; comment?: string }) => {
      try {
        const client = createClient();
        const repoId = opts.repo;

        let status: string;
        let body: string | undefined;

        if (opts.approve) {
          status = "approve";
          body = undefined;
        } else if (opts.reject) {
          status = "reject";
          body = opts.reject;
        } else if (opts.comment) {
          status = "comment";
          body = opts.comment;
        } else {
          console.error(chalk.red("Specify --approve, --reject <reason>, or --comment <text>"));
          process.exit(1);
        }

        await client.submitReview(repoId, id, { status, body });

        switch (status) {
          case "approve":
            console.log(chalk.green(`Change ${chalk.bold(id)} approved.`));
            break;
          case "reject":
            console.log(chalk.red(`Change ${chalk.bold(id)} rejected.`));
            console.log(chalk.dim(`Reason: ${body}`));
            break;
          case "comment":
            console.log(chalk.green(`Comment submitted on change ${chalk.bold(id)}.`));
            console.log(chalk.dim(`Comment: ${body}`));
            break;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Review failed: ${message}`));
        process.exit(1);
      }
    });
}
