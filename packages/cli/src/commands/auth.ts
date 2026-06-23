import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { ApiClient, ApiError } from "../lib/api.js";
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

// Prompt for a single line of input on a TTY (echoed). Used for email/name.
async function promptLine(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise(resolve => {
    rl.question(label, answer => {
      rl.close();
      resolve(answer.trim());
    });
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
    .description("Log in with email + password (prompts for both if not supplied)")
    .option("-e, --email <email>", "account email (prompts if omitted)")
    .option("-p, --password <pw>", "password (avoid — lands in shell history; prefer --password-stdin or the interactive prompt)")
    .option("--password-stdin", "read the password from stdin (keeps it out of argv and shell history)")
    .action(async opts => {
      let email: string | undefined = opts.email;
      if (!email) email = await promptLine("Email: ");
      if (!email) { console.error(chalk.red("✗ no email provided")); process.exit(1); }
      let password: string | undefined = opts.password;
      if (opts.passwordStdin) {
        password = await readStdin();
      } else if (!password) {
        password = await promptPassword();
      }
      if (!password) { console.error(chalk.red("✗ no password provided")); process.exit(1); }
      const client = new ApiClient();
      let res: { token: string; user: { email: string; username?: string } };
      try {
        res = await client.request("POST", "/api/v1/users/login", { body: { email, password }, throwOnError: true });
      } catch (err) {
        if (err instanceof ApiError) {
          console.error(chalk.red(`✗ ${err.message}`));
          const dashboard = client.server.replace(/^(https?:\/\/)api\./, "$1");
          console.error(chalk.gray("  No account yet? Run ") + chalk.cyan("ch register") + chalk.gray(` or sign up at ${dashboard}/register`));
          process.exit(1);
        }
        throw err;
      }
      const cfg = loadConfig();
      // Persist the handle so `ch init` can wire a human push remote in one step.
      saveConfig({ ...cfg, userToken: res.token, userHandle: res.user.username ?? cfg.userHandle });
      console.log(chalk.green(`✓ logged in as ${res.user.email}${res.user.username ? ` (@${res.user.username})` : ""}`));
      console.log(chalk.gray("  Next: run ") + chalk.cyan("ch init") + chalk.gray(" in a project dir — you'll push your own code directly."));
    });

  program.command("register")
    .description("Create a ClawHub account (prompts for email + password if not supplied)")
    .option("-e, --email <email>", "account email (prompts if omitted)")
    .option("-n, --name <name>", "display name (optional)")
    .option("-p, --password <pw>", "password (avoid — lands in shell history; prefer --password-stdin or the interactive prompt)")
    .option("--password-stdin", "read the password from stdin (keeps it out of argv and shell history)")
    .action(async opts => {
      let email: string | undefined = opts.email;
      if (!email) email = await promptLine("Email: ");
      if (!email) { console.error(chalk.red("✗ no email provided")); process.exit(1); }
      let name: string | undefined = opts.name;
      if (name === undefined && !opts.passwordStdin) {
        const entered = await promptLine("Name (optional): ");
        name = entered || undefined;
      }
      let password: string | undefined = opts.password;
      if (opts.passwordStdin) {
        password = await readStdin();
      } else if (!password) {
        password = await promptPassword();
      }
      if (!password) { console.error(chalk.red("✗ no password provided")); process.exit(1); }
      const client = new ApiClient();
      let res: { token: string; user: { email: string; username?: string } };
      try {
        res = await client.request("POST", "/api/v1/users/register", { body: { email, name, password }, throwOnError: true });
      } catch (err) {
        if (err instanceof ApiError) {
          console.error(chalk.red(`✗ ${err.message}`));
          if (err.status === 409) console.error(chalk.gray("  Already have an account? Run ") + chalk.cyan("ch login") + chalk.gray("."));
          process.exit(1);
        }
        throw err;
      }
      const cfg = loadConfig();
      saveConfig({ ...cfg, userToken: res.token, userHandle: res.user.username ?? cfg.userHandle });
      console.log(chalk.green(`✓ account created — logged in as ${res.user.email}${res.user.username ? ` (@${res.user.username})` : ""}`));
      console.log(chalk.gray("  Next: run ") + chalk.cyan("ch init") + chalk.gray(" in a project dir to connect it to ClawHub and push your code."));
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
      saveConfig({ ...loadConfig(), userToken: undefined, userHandle: undefined, agentToken: undefined, agentName: undefined });
      console.log(chalk.green("✓ logged out"));
    });

  program.command("whoami")
    .description("Show current auth status")
    .action(async () => {
      const cfg = loadConfig();
      if (cfg.userToken) {
        const client = new ApiClient();
        const me = await client.request<{ email: string; name?: string; username?: string }>("GET", "/api/v1/users/me", { tokenKind: "user" });
        console.log(chalk.cyan(`user: ${me.email}${me.username ? ` (@${me.username})` : ""}${me.name ? ` — ${me.name}` : ""}`));
        // Keep the cached handle fresh for git-remote construction.
        if (me.username && me.username !== cfg.userHandle) saveConfig({ ...cfg, userHandle: me.username });
      }
      if (cfg.agentToken) console.log(chalk.cyan(`agent: ${cfg.agentName}`));
      if (cfg.ownerHandle) console.log(chalk.cyan(`owner: @${cfg.ownerHandle}`));
      if (!cfg.userToken && !cfg.agentToken) console.log(chalk.gray("not logged in"));
    });
}
