import { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../lib/api-client.js";
import { getRemoteUrl } from "../lib/git.js";

function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } {
  const cleaned = remoteUrl.replace(/\.git\s*$/, "");
  const parts = cleaned.split("/");
  if (parts.length < 2) {
    throw new Error(
      `Cannot determine owner/repo from remote URL: ${remoteUrl}`,
    );
  }
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

async function resolveOwnerRepo(): Promise<{ owner: string; repo: string }> {
  try {
    const url = await getRemoteUrl("origin");
    return parseOwnerRepo(url);
  } catch {
    console.error(
      chalk.red(
        "Could not determine owner/repo. Run from inside a cloned ClawForge repo.",
      ),
    );
    process.exit(1);
  }
}

export function registerReviewCommands(program: Command): void {
  program
    .command("review <id>")
    .description("Submit a structured review for a change")
    .option("--approve", "Approve the change")
    .option("--reject <reason>", "Reject the change with a reason")
    .option("--comment <text>", "Add a comment")
    .action(
      async (
        id: string,
        opts: { approve?: boolean; reject?: string; comment?: string },
      ) => {
        try {
          const { owner, repo } = await resolveOwnerRepo();
          const client = createClient();

          let verdict: string;
          let body: string | undefined;

          if (opts.approve) {
            verdict = "approve";
            body = undefined;
          } else if (opts.reject) {
            verdict = "request_changes";
            body = opts.reject;
          } else if (opts.comment) {
            verdict = "comment";
            body = opts.comment;
          } else {
            console.error(
              chalk.red(
                "Specify --approve, --reject <reason>, or --comment <text>",
              ),
            );
            process.exit(1);
          }

          await client.submitReview(owner, repo, id, { verdict, body });

          switch (verdict) {
            case "approve":
              console.log(chalk.green(`Change ${chalk.bold(id)} approved.`));
              break;
            case "request_changes":
              console.log(chalk.red(`Change ${chalk.bold(id)} rejected.`));
              if (body) console.log(chalk.dim(`Reason: ${body}`));
              break;
            case "comment":
              console.log(
                chalk.green(
                  `Comment submitted on change ${chalk.bold(id)}.`,
                ),
              );
              if (body) console.log(chalk.dim(`Comment: ${body}`));
              break;
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Review failed: ${message}`));
          process.exit(1);
        }
      },
    );
}
