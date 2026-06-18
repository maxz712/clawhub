import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { parseRepo } from "../lib/repo.js";

interface Pipeline {
  name: string;
  enabled: boolean;
  triggerKind: "push" | "merge" | "schedule" | "event";
  triggerConfig: { cron?: string; event?: string };
}

// Render a pipeline's trigger as push / merge / schedule:<cron> / event:<type>.
function describeTrigger(p: Pipeline): string {
  switch (p.triggerKind) {
    case "schedule": return chalk.magenta(`schedule:${p.triggerConfig.cron ?? "?"}`) + chalk.gray(" (UTC)");
    case "event":    return chalk.blue(`event:${p.triggerConfig.event ?? "?"}`);
    case "merge":    return chalk.yellow("merge");
    case "push":
    default:         return chalk.green("push");
  }
}

export function registerCiCommands(program: Command) {
  const g = program.command("ci").description("CI runs + pipelines");

  g.command("runs [changeId]")
    .description("List CI runs (optionally filtered by change)")
    .action(async changeId => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const q = changeId ? `?change=${changeId}` : "";
      const { runs } = await client.request<{ runs: Array<{ id: string; status: string; logUrl: string | null; createdAt: string }> }>("GET", `/api/v1/repos/${ns}/${repo}/ci/runs${q}`);
      if (!runs.length) { console.log(chalk.gray("(no CI runs)")); return; }
      for (const r of runs) console.log(`${chalk.cyan(r.id.slice(0, 8))} ${r.status.padEnd(8)} ${r.createdAt} ${r.logUrl ?? ""}`);
    });

  g.command("pipelines [ns/repo]")
    .description("List pipelines with their trigger (push|merge|schedule:<cron>|event:<type>)")
    .action(async (repoArg?: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const { pipelines } = await client.request<{ pipelines: Pipeline[] }>("GET", `/api/v1/repos/${ns}/${repo}/ci/pipelines`);
      if (!pipelines.length) { console.log(chalk.gray("(no pipelines)")); return; }
      for (const p of pipelines) {
        const state = p.enabled ? "" : chalk.gray(" (disabled)");
        console.log(`${chalk.bold(p.name.padEnd(24))} ${describeTrigger(p)}${state}`);
      }
    });

  g.command("run [ns/repo] <pipeline>")
    .description("Manually trigger a pipeline run")
    .action(async (a: string, b: string | undefined) => {
      // commander fills positionals left-to-right: with one value, `a` is the
      // pipeline and the repo comes from the git remote; with two, `a` is ns/repo.
      const repoArg = b === undefined ? undefined : a;
      const pipeline = b === undefined ? a : b;
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      // First confirm the pipeline exists (and surface its trigger) so the
      // operator gets a precise error instead of a generic 404 on trigger.
      const { pipelines } = await client.request<{ pipelines: Pipeline[] }>("GET", `/api/v1/repos/${ns}/${repo}/ci/pipelines`);
      const match = pipelines.find(p => p.name === pipeline);
      if (!match) {
        console.error(chalk.red(`✗ no pipeline named "${pipeline}" in ${ns}/${repo}`));
        if (pipelines.length) console.error(chalk.gray(`  available: ${pipelines.map(p => p.name).join(", ")}`));
        process.exit(1);
      }
      // The API does not yet expose a manual-trigger endpoint — pipelines fire
      // on push/merge/schedule/event only. Tell the operator how this one runs
      // instead of pretending to enqueue a run.
      console.log(chalk.yellow("manual trigger is not available via the API yet."));
      console.log(`${chalk.bold(match.name)} runs on ${describeTrigger(match)}.`);
      switch (match.triggerKind) {
        case "push":
          console.log(chalk.gray("  → push a Change to this repo to run it."));
          break;
        case "merge":
          console.log(chalk.gray("  → merge a Change to the default branch to run it."));
          break;
        case "schedule":
          console.log(chalk.gray(`  → fires automatically on the cron schedule (UTC); the ~60s scheduler enqueues it at default-branch HEAD.`));
          break;
        case "event":
          console.log(chalk.gray(`  → fires automatically when "${match.triggerConfig.event}" occurs in this repo.`));
          break;
      }
      console.log(chalk.gray("  See docs/ci.md → Agentic triggers."));
    });
}
