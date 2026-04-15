import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { ApiClient } from "../lib/api.js";

function parseRepo(): { ns: string; repo: string } {
  const remote = execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim();
  const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) { console.error(chalk.red("cannot parse remote")); process.exit(1); }
  return { ns: m[1], repo: m[2] };
}

export function registerCiCommands(program: Command) {
  const g = program.command("ci").description("CI runs");

  g.command("runs [changeId]")
    .description("List CI runs (optionally filtered by change)")
    .action(async changeId => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const q = changeId ? `?change=${changeId}` : "";
      const { runs } = await client.request<{ runs: Array<{ id: string; status: string; logUrl: string | null; createdAt: string }> }>("GET", `/api/v1/repos/${ns}/${repo}/ci/runs${q}`);
      for (const r of runs) console.log(`${chalk.cyan(r.id.slice(0, 8))} ${r.status.padEnd(8)} ${r.createdAt} ${r.logUrl ?? ""}`);
    });
}
