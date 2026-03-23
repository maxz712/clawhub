import { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../lib/api-client.js";

interface RepoSummary {
  id: string;
  name?: string;
  owner?: string;
  pendingChanges?: number;
  approvedChanges?: number;
  mergedChanges?: number;
  rejectedChanges?: number;
  totalChanges?: number;
  activeAgents?: number;
  attentionItems?: number;
  risk?: string;
  [key: string]: unknown;
}

function riskColor(risk?: string): string {
  if (!risk) return chalk.dim("--");
  switch (risk.toLowerCase()) {
    case "low":
      return chalk.green(risk);
    case "medium":
      return chalk.yellow(risk);
    case "high":
      return chalk.red(risk);
    case "critical":
      return chalk.bgRed.white(risk);
    default:
      return risk;
  }
}

export function registerStatusCommands(program: Command): void {
  program
    .command("status")
    .description("Project health summary across all repositories")
    .action(async () => {
      try {
        const client = createClient();
        const result = (await client.getDashboard()) as
          | RepoSummary[]
          | { repos: RepoSummary[] };

        const repos: RepoSummary[] = Array.isArray(result)
          ? result
          : ((result as { repos: RepoSummary[] }).repos ?? []);

        if (repos.length === 0) {
          console.log(chalk.dim("\n  No repositories found.\n"));
          return;
        }

        console.log(chalk.bold("\n  Project Health Summary\n"));

        let totalPending = 0;
        let totalApproved = 0;
        let totalMerged = 0;
        let totalAttention = 0;

        for (const r of repos) {
          const repoLabel = r.owner
            ? `${r.owner}/${r.name ?? r.id}`
            : (r.name ?? r.id);

          const pending = r.pendingChanges ?? 0;
          const approved = r.approvedChanges ?? 0;
          const merged = r.mergedChanges ?? 0;
          const attention = r.attentionItems ?? 0;
          const agents = r.activeAgents ?? 0;

          totalPending += pending;
          totalApproved += approved;
          totalMerged += merged;
          totalAttention += attention;

          console.log(`  ${chalk.bold(repoLabel)}`);
          console.log(
            `    ${chalk.cyan(`${pending} pending`)}  ` +
              `${chalk.green(`${approved} approved`)}  ` +
              `${chalk.magenta(`${merged} merged`)}  ` +
              `${agents > 0 ? chalk.dim(`${agents} agent${agents === 1 ? "" : "s"}`) : ""}`,
          );
          if (attention > 0) {
            console.log(
              `    ${chalk.red.bold(`${attention} item${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention`)}`,
            );
          }
          console.log();
        }

        console.log(chalk.dim("  " + "-".repeat(50)));
        console.log(
          `  ${chalk.bold("Totals:")}  ` +
            `${chalk.cyan(`${totalPending} pending`)}  ` +
            `${chalk.green(`${totalApproved} approved`)}  ` +
            `${chalk.magenta(`${totalMerged} merged`)}`,
        );
        if (totalAttention > 0) {
          console.log(
            `  ${chalk.red.bold(`${totalAttention} item${totalAttention === 1 ? "" : "s"} need${totalAttention === 1 ? "s" : ""} attention`)}`,
          );
        }
        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Status failed: ${message}`));
        process.exit(1);
      }
    });
}
