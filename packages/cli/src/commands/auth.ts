import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { ApiClient } from "../lib/api.js";
import { loadConfig, saveConfig } from "../lib/config.js";

// Read the whole of stdin (used by `--password-stdin`).
async function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (data += c));
    process.stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
  });
}

// Prompt for a password on a TTY without echoing it to the terminal.
async function promptPassword(label = "Password: "): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = process.stdout;
  // Mute echo: intercept the writer so typed chars don't render.
  const realWrite = (out as unknown as { write: (s: string) => boolean }).write.bind(out);
  let muted = false;
  (out as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => (muted ? true : realWrite(s));
  return new Promise(resolve => {
    rl.question(label, answer => {
      (out as unknown as { write: (s: string) => boolean }).write = realWrite;
      out.write("\n");
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

export function registerAuthCommands(program: Command) {
  program.command("login")
    .description("Log in with email + password (prompts for the password if not supplied)")
    .requiredOption("-e, --email <email>")
    .option("-p, --password <pw>", "password (avoid — lands in shell history; prefer --password-stdin or the interactive prompt)")
    .option("--password-stdin", "read the password from stdin (keeps it out of argv and shell history)")
    .action(async opts => {
      const { email } = opts;
      let password: string | undefined = opts.password;
      if (opts.passwordStdin) {
        password = await readStdin();
      } else if (!password) {
        password = await promptPassword();
      }
      if (!password) { console.error(chalk.red("✗ no password provided")); process.exit(1); }
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
