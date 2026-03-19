import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { setConfig } from "../lib/config.js";
import { ApiClient } from "../lib/api-client.js";
import { execGit } from "../lib/git.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Set up ClawForge for an agent in the current git repo")
    .option("--token <jwt>", "Agent JWT token (or set CLAWFORGE_TOKEN)")
    .option("--url <url>", "ClawForge API URL", "http://localhost:3000")
    .option("--repo <name>", "Repository name on ClawForge (default: current directory name)")
    .option("--remote <name>", "Git remote name", "clawforge")
    .action(async (opts: { token?: string; url: string; repo?: string; remote: string }) => {
      try {
        const token = opts.token || process.env.CLAWFORGE_TOKEN;
        if (!token) {
          console.error(chalk.red("Token required. Use --token <jwt> or set CLAWFORGE_TOKEN."));
          process.exit(1);
        }

        const apiUrl = opts.url.replace(/\/+$/, "");

        // 1. Save config
        setConfig("api_url", apiUrl);
        setConfig("token", token);
        console.log(chalk.dim("Saved config to ~/.clawforge/config.json"));

        // 2. Validate token and get agent + owner info
        const client = new ApiClient(apiUrl, token);
        let agentInfo: Awaited<ReturnType<typeof client.getAgentMe>>;
        try {
          agentInfo = await client.getAgentMe();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Token validation failed: ${message}`));
          process.exit(1);
        }

        const agentName = agentInfo.agent.name as string;
        const ownerEmail = agentInfo.owner.email;
        const owner = ownerEmail.split("@")[0];
        console.log(
          chalk.dim(`Authenticated as agent ${chalk.cyan(agentName)} (owner: ${chalk.cyan(owner)})`)
        );

        // 3. Derive repo name
        const repoName = opts.repo || basename(process.cwd());

        // 4. Add git remote
        const remoteUrl = `${apiUrl}/${owner}/${repoName}.git`;
        try {
          await execGit("remote", "add", opts.remote, remoteUrl);
          console.log(chalk.dim(`Added remote ${chalk.cyan(opts.remote)} → ${remoteUrl}`));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("already exists")) {
            // Update existing remote
            await execGit("remote", "set-url", opts.remote, remoteUrl);
            console.log(chalk.dim(`Updated remote ${chalk.cyan(opts.remote)} → ${remoteUrl}`));
          } else {
            throw err;
          }
        }

        // 5. Configure git credentials
        const parsedUrl = new URL(apiUrl);
        const credentialLine = `${parsedUrl.protocol}//agent-token:${token}@${parsedUrl.host}`;
        const credFile = join(homedir(), ".git-credentials");

        // Avoid duplicate entries
        let existingCreds = "";
        if (existsSync(credFile)) {
          existingCreds = readFileSync(credFile, "utf-8");
        }
        if (!existingCreds.includes(credentialLine)) {
          appendFileSync(credFile, (existingCreds && !existingCreds.endsWith("\n") ? "\n" : "") + credentialLine + "\n", "utf-8");
        }

        await execGit("config", "credential.helper", "store");
        console.log(chalk.dim("Configured git credentials"));

        // 6. Configure change refs fetch
        await execGit(
          "config",
          "--add",
          `remote.${opts.remote}.fetch`,
          `+refs/changes/*/head:refs/remotes/${opts.remote}/changes/*`
        );
        console.log(chalk.dim("Configured change refs fetch"));

        // 7. Print summary
        console.log("");
        console.log(chalk.green.bold("ClawForge initialized!"));
        console.log("");
        console.log(`  Agent:  ${chalk.cyan(agentName)}`);
        console.log(`  Owner:  ${chalk.cyan(owner)}`);
        console.log(`  Repo:   ${chalk.cyan(`${owner}/${repoName}`)}`);
        console.log(`  Remote: ${chalk.cyan(opts.remote)}`);
        console.log("");
        console.log(chalk.dim("Next steps:"));
        console.log(chalk.dim(`  git push ${opts.remote} main`));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Init failed: ${message}`));
        process.exit(1);
      }
    });
}
