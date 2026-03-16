import { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../lib/api-client.js";

interface ChangeRecord {
  id: string;
  title?: string;
  status?: string;
  branch?: string;
  intent?: string;
  risk?: string;
  createdAt?: string;
  [key: string]: unknown;
}

function riskColor(risk?: string): string {
  if (!risk) return chalk.dim("unknown");
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
    .description("Show summary of changes for a repository")
    .requiredOption("--repo <id>", "Repository ID")
    .action(async (opts: { repo: string }) => {
      try {
        const client = createClient();
        const result = (await client.listChanges(opts.repo)) as ChangeRecord[] | { changes: ChangeRecord[] };

        const changes: ChangeRecord[] = Array.isArray(result)
          ? result
          : (result as { changes: ChangeRecord[] }).changes ?? [];

        const counts = {
          pending: 0,
          approved: 0,
          merged: 0,
          rejected: 0,
        };

        for (const c of changes) {
          const s = (c.status ?? "").toLowerCase();
          if (s in counts) {
            counts[s as keyof typeof counts]++;
          }
        }

        console.log(chalk.bold("\n  Repository Status\n"));
        console.log(`  ${chalk.cyan("Pending:")}   ${counts.pending}`);
        console.log(`  ${chalk.green("Approved:")}  ${counts.approved}`);
        console.log(`  ${chalk.magenta("Merged:")}    ${counts.merged}`);
        console.log(`  ${chalk.red("Rejected:")}  ${counts.rejected}`);
        console.log(`  ${chalk.dim("Total:")}     ${changes.length}`);

        const pending = changes.filter((c) => (c.status ?? "").toLowerCase() === "pending");

        if (pending.length > 0) {
          console.log(chalk.bold("\n  Pending Changes\n"));
          console.log(
            chalk.dim("  ID".padEnd(40)) +
            chalk.dim("Intent".padEnd(30)) +
            chalk.dim("Risk")
          );
          console.log(chalk.dim("  " + "\u2014".repeat(75)));

          for (const c of pending) {
            const intent = c.intent ?? "\u2014";
            const truncatedIntent = intent.length > 27 ? intent.slice(0, 27) + "..." : intent;
            console.log(
              `  ${(c.id ?? "").toString().padEnd(38)}` +
              `${truncatedIntent.padEnd(30)}` +
              `${riskColor(c.risk)}`
            );
          }
        } else {
          console.log(chalk.dim("\n  No pending changes."));
        }

        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Status failed: ${message}`));
        process.exit(1);
      }
    });
}
