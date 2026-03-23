import { Command } from "commander";
import chalk from "chalk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getApiUrl } from "../lib/config.js";

const execFileAsync = promisify(execFile);

export function registerCloneCommands(program: Command): void {
  program
    .command("clone <ownerRepo>")
    .description("Clone a ClawForge repository (owner/repo)")
    .action(async (ownerRepo: string) => {
      try {
        const apiUrl = getApiUrl();
        const gitUrl = `${apiUrl}/${ownerRepo}.git`;

        const args: string[] = [
          "clone",
          // Automatically fetch change refs alongside normal refs
          "--config",
          "remote.origin.fetch=+refs/changes/*/head:refs/remotes/origin/changes/*",
          gitUrl,
        ];

        console.log(
          chalk.dim(`Cloning ${chalk.cyan(ownerRepo)} from ${gitUrl}...`),
        );

        const { stdout, stderr } = await execFileAsync("git", args, {
          stdio: "pipe",
        });

        if (stdout) console.log(stdout);
        if (stderr) console.log(chalk.dim(stderr));

        console.log(
          chalk.green(`\nCloned ${chalk.bold(ownerRepo)} successfully.`),
        );
        console.log(
          chalk.dim("Change refs will be fetched automatically on git fetch."),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Clone failed: ${message}`));
        process.exit(1);
      }
    });
}
