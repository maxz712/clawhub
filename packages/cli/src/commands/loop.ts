import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { loadConfig } from "../lib/config.js";
import { parseRepo } from "../lib/repo.js";

interface LoopAgent { id: string; name: string; status: string; enabled: boolean; consecutiveFailures: number; lastRunAt: string | null }
interface LoopStatus { loop: { autonomy: string; status: string }; roles: Array<{ name: string; capability: string }>; agents: LoopAgent[] }

// The autonomous Loop (M8): one-click developer + verified-reviewer bundle with a
// policy dial. `ch loop install --autonomy medium --repo ns/repo`.
export function registerLoopCommands(program: Command) {
  const loop = program.command("loop").description("Manage a repo's autonomous Loop (developer + verified-reviewer bundle)");

  loop.command("install")
    .description("Install the Loop on a repo")
    .requiredOption("--repo <ns/repo>", "target repo")
    .option("--autonomy <level>", "review_only | low | medium (default review_only)", "review_only")
    .option("--triager", "also deploy an issue triager")
    .option("--scout", "also deploy an issue scout (files issues on the cadence — the front of the loop)")
    .option("--cadence <c>", "developer/scout work cadence: daily | twice_daily | hourly | weekly (default daily)", "daily")
    .option("--dev-kind <k>", "developer flavor: ui (browser dev loop) | code (worker — implements code+tests, no app boot). Default ui", "ui")
    .action(async (opts: { repo: string; autonomy: string; triager?: boolean; scout?: boolean; cadence: string; devKind: string }) => {
      const client = new ApiClient(loadConfig());
      const { ns, repo } = parseRepo(opts.repo);
      await client.request("POST", `/api/v1/repos/${ns}/${repo}/loop`, { tokenKind: "user", body: { autonomy: opts.autonomy, includeTriager: !!opts.triager, includeScout: !!opts.scout, cadence: opts.cadence, devKind: opts.devKind } });
      console.log(chalk.green(`✓ Loop installed on ${ns}/${repo} at autonomy=${opts.autonomy}, cadence=${opts.cadence}`));
      if (opts.autonomy === "medium") console.log(chalk.gray("  medium autonomy: a verified attestation auto-merges up to medium risk (RECOMMENDED floor ON)."));
      if (opts.scout) console.log(chalk.gray("  scout ON: it files one issue per cadence tick, which the developer then grabs + builds. Fully hands-off."));
      console.log(chalk.gray("  file an issue, and the developer will grab it, build it, and open a Change the verifier attests."));
    });

  loop.command("status")
    .description("Show the Loop's status + per-role health")
    .requiredOption("--repo <ns/repo>", "target repo")
    .action(async (opts: { repo: string }) => {
      const client = new ApiClient(loadConfig());
      const { ns, repo } = parseRepo(opts.repo);
      const { status } = await client.request<{ status: LoopStatus | null }>("GET", `/api/v1/repos/${ns}/${repo}/loop`, { tokenKind: "user" });
      if (!status) { console.log(chalk.gray("No Loop installed on this repo.")); return; }
      console.log(chalk.bold(`Loop · ${ns}/${repo}`) + chalk.gray(`  autonomy=${status.loop.autonomy}  status=${status.loop.status}`));
      for (const a of status.agents) {
        const flag = a.enabled ? (a.consecutiveFailures > 0 ? chalk.yellow(`⚠ ${a.consecutiveFailures} fails`) : chalk.green("● ok")) : chalk.gray("○ paused");
        console.log(`  ${flag}  ${a.name} ${chalk.gray(`(${a.status}${a.lastRunAt ? `, last ${new Date(a.lastRunAt).toLocaleString()}` : ""})`)}`);
      }
    });

  loop.command("kill")
    .description("Pause the Loop (its agents stop running)")
    .requiredOption("--repo <ns/repo>", "target repo")
    .action(async (opts: { repo: string }) => {
      const client = new ApiClient(loadConfig());
      const { ns, repo } = parseRepo(opts.repo);
      await client.request("POST", `/api/v1/repos/${ns}/${repo}/loop/kill`, { tokenKind: "user" });
      console.log(chalk.yellow(`✓ Loop paused on ${ns}/${repo}`));
    });

  loop.command("resume")
    .description("Resume a paused Loop")
    .requiredOption("--repo <ns/repo>", "target repo")
    .action(async (opts: { repo: string }) => {
      const client = new ApiClient(loadConfig());
      const { ns, repo } = parseRepo(opts.repo);
      await client.request("POST", `/api/v1/repos/${ns}/${repo}/loop/resume`, { tokenKind: "user" });
      console.log(chalk.green(`✓ Loop resumed on ${ns}/${repo}`));
    });

  loop.command("rm")
    .description("Uninstall the Loop (removes its agents; reverts the policy if unchanged)")
    .requiredOption("--repo <ns/repo>", "target repo")
    .action(async (opts: { repo: string }) => {
      const client = new ApiClient(loadConfig());
      const { ns, repo } = parseRepo(opts.repo);
      const r = await client.request<{ policyReverted: boolean }>("DELETE", `/api/v1/repos/${ns}/${repo}/loop`, { tokenKind: "user" });
      console.log(chalk.green(`✓ Loop uninstalled from ${ns}/${repo}`) + chalk.gray(r.policyReverted ? " (merge policy reverted)" : " (merge policy left as edited)"));
    });
}
