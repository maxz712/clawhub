import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { loadConfig } from "../lib/config.js";

export function registerCloneCommand(program: Command) {
  program.command("clone <target> [dir]")
    .description("Clone a ClawHub repo (target: <namespace>/<repo>)")
    .action((target, dir) => {
      const m = target.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!m) {
        console.error(chalk.red(`✗ cannot parse "${target}" — expected <namespace>/<repo>`));
        console.error(chalk.gray("  e.g. ") + chalk.cyan("ch clone xinmingzhang/clawhub"));
        process.exit(1);
      }
      const cfg = loadConfig();
      const serverUrl = new URL(cfg.server);
      // Prefer the human's own credentials when logged in (so a clone of a
      // private repo they can read just works, and a subsequent `git push`
      // authors as them). Fall back to an agent token, then an anonymous clone.
      const creds = cfg.userToken && cfg.userHandle
        ? { user: cfg.userHandle, token: cfg.userToken }
        : cfg.agentToken
          ? { user: "agent-token", token: cfg.agentToken }
          : null;
      const plainUrl = `${serverUrl.origin}/${m[1]}/${m[2]}.git`;
      const remote = creds
        ? `${serverUrl.protocol}//${encodeURIComponent(creds.user)}:${creds.token}@${serverUrl.host}/${m[1]}/${m[2]}.git`
        : plainUrl;
      try {
        execSync(`git clone ${JSON.stringify(remote)}${dir ? ` ${JSON.stringify(dir)}` : ""}`, { stdio: "inherit" });
      } catch {
        // A clone with no embedded credentials that fails is almost always a
        // private repo the anonymous fetch can't see. Point the user at auth.
        if (!creds) {
          console.error(chalk.red(`✗ clone failed — ${m[1]}/${m[2]} may be private and you have no credentials.`));
          console.error(chalk.gray("  Run ") + chalk.cyan("ch login") + chalk.gray(" (or ") + chalk.cyan("ch init") + chalk.gray(") first, then retry the clone."));
        }
        process.exit(1);
      }
    });
}
