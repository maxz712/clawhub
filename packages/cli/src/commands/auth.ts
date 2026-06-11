import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { loadConfig, saveConfig } from "../lib/config.js";

export function registerAuthCommands(program: Command) {
  program.command("login")
    .description("Log in with email + password")
    .requiredOption("-e, --email <email>")
    .requiredOption("-p, --password <pw>")
    .action(async ({ email, password }) => {
      const client = new ApiClient();
      const { token, user } = await client.request<{ token: string; user: { email: string } }>("POST", "/api/v1/users/login", { body: { email, password } });
      const cfg = loadConfig();
      saveConfig({ ...cfg, userToken: token });
      console.log(chalk.green(`✓ logged in as ${user.email}`));
    });

  program.command("server [url]")
    .description("Show or set the ClawHub server URL")
    .action(url => {
      const cfg = loadConfig();
      if (!url) { console.log(cfg.server); return; }
      const normalized = url.replace(/\/+$/, "");
      saveConfig({ ...cfg, server: normalized });
      console.log(chalk.green(`✓ server set to ${normalized}`));
    });

  program.command("logout")
    .description("Clear stored tokens")
    .action(() => {
      saveConfig({ ...loadConfig(), userToken: undefined, agentToken: undefined, agentName: undefined });
      console.log(chalk.green("✓ logged out"));
    });

  program.command("whoami")
    .description("Show current auth status")
    .action(async () => {
      const cfg = loadConfig();
      if (cfg.userToken) {
        const client = new ApiClient();
        const me = await client.request<{ email: string; name?: string }>("GET", "/api/v1/users/me", { tokenKind: "user" });
        console.log(chalk.cyan(`user: ${me.email}${me.name ? ` (${me.name})` : ""}`));
      }
      if (cfg.agentToken) console.log(chalk.cyan(`agent: ${cfg.agentName}`));
      if (!cfg.userToken && !cfg.agentToken) console.log(chalk.gray("not logged in"));
    });
}
