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
    .description("Install an agent loop on a repo (one-click preset or custom role set)")
    .requiredOption("--repo <ns/repo>", "target repo")
    .option("--preset <p>", "loop shape: full | dev-review | scout-dev | scout | dev | review (default: dev-review)")
    .option("--autonomy <level>", "review_only (humans merge) | low (agent merges its OWN low-risk work; medium+ risk and sensitive paths still need a human) | medium (full autonomy — a verified attestation auto-merges)", "review_only")
    .option("--triager", "also deploy an issue triager")
    .option("--scout", "also deploy an issue scout (files issues on the cadence — the front of the loop)")
    .option("--cadence <c>", "developer/scout work cadence: daily | twice_daily | hourly | weekly (default daily)", "daily")
    .option("--dev-kind <k>", "developer flavor: ui (browser dev loop) | code (worker — implements code+tests, no app boot). Default ui", "ui")
    .option("--scout-prompt <text>", "custom scout focus (e.g. 'find missing tests in packages/api')")
    .option("--dev-prompt <text>", "custom developer directive (leave empty in a loop so it grabs the scout's issues)")
    .option("--review-prompt <text>", "custom reviewer focus")
    .option("--key <source>", "byo (your keys, default) | platform (zero-setup: ClawHub-metered inference behind the auto-created Loop budget)", "byo")
    .action(async (opts: { repo: string; preset?: string; autonomy: string; triager?: boolean; scout?: boolean; cadence: string; devKind: string; scoutPrompt?: string; devPrompt?: string; reviewPrompt?: string; key: string }) => {
      const client = new ApiClient(loadConfig());
      const { ns, repo } = parseRepo(opts.repo);
      const body: Record<string, unknown> = { autonomy: opts.autonomy, cadence: opts.cadence, devKind: opts.devKind, preset: opts.preset };
      // Per-role custom prompts (only sent when provided).
      if (opts.scoutPrompt) body.scout = { prompt: opts.scoutPrompt };
      if (opts.devPrompt) body.developer = { prompt: opts.devPrompt };
      if (opts.reviewPrompt) body.reviewer = { prompt: opts.reviewPrompt };
      // Back-compat flags still work alongside a preset.
      if (opts.scout) body.includeScout = true;
      if (opts.triager) body.includeTriager = true;
      if (opts.key === "platform") body.keySource = "platform";
      await client.request("POST", `/api/v1/repos/${ns}/${repo}/loop`, { tokenKind: "user", body });
      console.log(chalk.green(`✓ Loop installed on ${ns}/${repo}${opts.preset ? ` (${opts.preset})` : ""} at autonomy=${opts.autonomy}, cadence=${opts.cadence}`));
      if (opts.autonomy === "medium") console.log(chalk.gray("  full autonomy: a verified attestation auto-merges up to medium risk (RECOMMENDED floor ON)."));
      if (opts.preset === "full" || opts.scout) console.log(chalk.gray("  scout ON: files one issue per cadence tick → the developer grabs + builds it → the reviewer verifies + merges. Hands-off."));
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
