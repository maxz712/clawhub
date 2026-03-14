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
    .option("--scope <glob>", "Sparse checkout pattern")
    .option("--shallow", "Shallow clone (--depth 1)")
    .action(async (ownerRepo: string, opts: { scope?: string; shallow?: boolean }) => {
      try {
        const apiUrl = getApiUrl();
        const gitUrl = `${apiUrl}/${ownerRepo}.git`;

        const args: string[] = ["clone"];

        // Configure fetching change refs alongside normal refs
        args.push(
          "--config",
          "remote.origin.fetch=+refs/changes/*/head:refs/remotes/origin/changes/*"
        );

        if (opts.shallow) {
          args.push("--depth", "1");
        }

        if (opts.scope) {
          args.push("--filter=blob:none", "--sparse");
        }

        args.push(gitUrl);

        console.log(chalk.dim(`Cloning ${chalk.cyan(ownerRepo)} from ${gitUrl}...`));

        const { stdout, stderr } = await execFileAsync("git", args, {
          stdio: "pipe",
        });

        if (stdout) console.log(stdout);
        if (stderr) console.log(chalk.dim(stderr));

        // If sparse checkout scope was specified, set it up
        if (opts.scope) {
          const repoName = ownerRepo.split("/").pop() || ownerRepo;
          await execFileAsync("git", ["sparse-checkout", "set", opts.scope], {
            cwd: repoName,
          });
          console.log(chalk.dim(`Sparse checkout set to: ${opts.scope}`));
        }

        console.log(chalk.green(`\nCloned ${chalk.bold(ownerRepo)} successfully.`));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Clone failed: ${message}`));
        process.exit(1);
      }
    });
}
