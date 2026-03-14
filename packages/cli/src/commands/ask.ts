import { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../lib/api-client.js";

interface AskResponse {
  answer?: string;
  response?: string;
  [key: string]: unknown;
}

export function registerAskCommands(program: Command): void {
  program
    .command("ask <question...>")
    .description("Ask a question about a repository's codebase")
    .requiredOption("--repo <id>", "Repository ID")
    .action(async (questionParts: string[], opts: { repo: string }) => {
      try {
        const client = createClient();
        const question = questionParts.join(" ");

        console.log(chalk.dim(`Asking about repo ${opts.repo}...\n`));

        const result = (await client.askAboutCodebase(opts.repo, question)) as AskResponse;
        const answer = result.answer ?? result.response ?? JSON.stringify(result, null, 2);

        console.log(chalk.bold("Answer:\n"));
        console.log(answer);
        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Ask failed: ${message}`));
        process.exit(1);
      }
    });
}
