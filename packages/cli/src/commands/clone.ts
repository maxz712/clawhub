import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { loadConfig } from "../lib/config.js";

export function registerCloneCommand(program: Command) {
  program.command("clone <target>")
    .description("Clone a ClawHub repo (target: <namespace>/<repo>)")
    .action(target => {
      const m = target.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!m) { console.error(chalk.red("target must be <namespace>/<repo>")); process.exit(1); }
      const cfg = loadConfig();
      const serverUrl = new URL(cfg.server);
      if (cfg.agentToken) {
        serverUrl.username = "agent-token";
        serverUrl.password = cfg.agentToken;
      }
      const url = `${serverUrl.origin}/${m[1]}/${m[2]}.git`;
      const remote = cfg.agentToken
        ? `${serverUrl.protocol}//agent-token:${cfg.agentToken}@${serverUrl.host}/${m[1]}/${m[2]}.git`
        : url;
      try {
        execSync(`git clone ${JSON.stringify(remote)}`, { stdio: "inherit" });
      } catch { process.exit(1); }
    });
}
