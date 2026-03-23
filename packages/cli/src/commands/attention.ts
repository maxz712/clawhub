import { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../lib/api-client.js";

interface AttentionItem {
  id: string;
  type?: string;
  changeId?: string;
  repoName?: string;
  owner?: string;
  intent?: string;
  risk?: string;
  reason?: string;
  status?: string;
  agentName?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface AttentionDetail {
  item: AttentionItem;
  change?: {
    id: string;
    status?: string;
    branch?: string;
    intent?: string;
    risk?: string;
    [key: string]: unknown;
  };
  focusAreas?: Array<{ file?: string; lines?: string; reason?: string }>;
  reviews?: Array<{
    verdict?: string;
    body?: string;
    userId?: string;
    createdAt?: string;
  }>;
  [key: string]: unknown;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "--";
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
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

export function registerAttentionCommands(program: Command): void {
  const attention = program
    .command("attention")
    .description("Human oversight -- items needing your judgment");

  // ── attention (list) ──────────────────────────────────────────────

  attention
    .command("list", { isDefault: true })
    .description("Show items needing human judgment")
    .action(async () => {
      try {
        const client = createClient();
        const result = (await client.listAttentionItems()) as
          | AttentionItem[]
          | { items: AttentionItem[] };

        const items: AttentionItem[] = Array.isArray(result)
          ? result
          : ((result as { items: AttentionItem[] }).items ?? []);

        if (items.length === 0) {
          console.log(
            chalk.green("\n  No items need your attention right now.\n"),
          );
          return;
        }

        console.log(
          chalk.bold(
            `\n  Attention Required (${items.length} item${items.length === 1 ? "" : "s"})\n`,
          ),
        );
        console.log(
          "  " +
            chalk.dim("ID".padEnd(10)) +
            chalk.dim("Risk".padEnd(10)) +
            chalk.dim("Repo".padEnd(20)) +
            chalk.dim("Agent".padEnd(16)) +
            chalk.dim("Reason".padEnd(30)) +
            chalk.dim("Created"),
        );
        console.log(chalk.dim("  " + "-".repeat(95)));

        for (const item of items) {
          const repoDisplay = item.repoName
            ? `${item.owner ?? ""}/${item.repoName}`
            : "--";
          const truncReason = (item.reason ?? "--").slice(0, 27);

          console.log(
            `  ${(item.id ?? "").toString().slice(0, 8).padEnd(10)}` +
              `${riskColor(item.risk).padEnd(10 + 10)}` +
              `${repoDisplay.padEnd(20)}` +
              `${(item.agentName ?? "--").padEnd(16)}` +
              `${truncReason.padEnd(30)}` +
              `${formatDate(item.createdAt)}`,
          );
        }
        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to list attention items: ${message}`));
        process.exit(1);
      }
    });

  // ── attention show <id> ───────────────────────────────────────────

  attention
    .command("show <id>")
    .description("Decision view for an escalated item")
    .action(async (id: string) => {
      try {
        const client = createClient();
        const view = (await client.getAttentionItem(id)) as AttentionDetail;

        const item = view.item ?? (view as unknown as AttentionItem);

        console.log(chalk.bold(`\n  Attention Item ${item.id}\n`));
        console.log(
          `  ${chalk.dim("Type:")}     ${item.type ?? "--"}`,
        );
        console.log(
          `  ${chalk.dim("Risk:")}     ${riskColor(item.risk)}`,
        );
        console.log(
          `  ${chalk.dim("Reason:")}   ${item.reason ?? "--"}`,
        );
        console.log(
          `  ${chalk.dim("Agent:")}    ${item.agentName ?? "--"}`,
        );
        console.log(
          `  ${chalk.dim("Repo:")}     ${item.owner ?? ""}/${item.repoName ?? "--"}`,
        );
        console.log(
          `  ${chalk.dim("Created:")}  ${formatDate(item.createdAt)}`,
        );

        if (view.change) {
          const c = view.change;
          console.log(chalk.bold("\n  Associated Change\n"));
          console.log(`  ${chalk.dim("Change ID:")} ${c.id}`);
          console.log(`  ${chalk.dim("Status:")}    ${c.status ?? "--"}`);
          console.log(`  ${chalk.dim("Branch:")}    ${c.branch ?? "--"}`);
          console.log(`  ${chalk.dim("Intent:")}    ${c.intent ?? "--"}`);
        }

        if (view.focusAreas && view.focusAreas.length > 0) {
          console.log(chalk.bold("\n  Focus Areas\n"));
          for (const area of view.focusAreas) {
            console.log(
              `  ${chalk.cyan(area.file ?? "unknown")}${area.lines ? chalk.dim(`:${area.lines}`) : ""}`,
            );
            if (area.reason) {
              console.log(`    ${chalk.dim(area.reason)}`);
            }
          }
        }

        if (view.reviews && view.reviews.length > 0) {
          console.log(chalk.bold("\n  Reviews\n"));
          for (const r of view.reviews) {
            const verdict =
              r.verdict === "approve"
                ? chalk.green("APPROVE")
                : r.verdict === "request_changes"
                  ? chalk.red("REQUEST CHANGES")
                  : chalk.dim(r.verdict ?? "comment");
            console.log(
              `  ${verdict}  ${chalk.dim(r.userId ?? "unknown")}  ${chalk.dim(formatDate(r.createdAt))}`,
            );
            if (r.body) {
              console.log(`    ${r.body}`);
            }
          }
        }

        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          chalk.red(`Failed to show attention item: ${message}`),
        );
        process.exit(1);
      }
    });

  // ── attention approve <id> ────────────────────────────────────────

  attention
    .command("approve <id>")
    .description("Human-approve an escalated item")
    .action(async (id: string) => {
      try {
        const client = createClient();
        await client.approveAttentionItem(id);
        console.log(
          chalk.green(`Item ${chalk.bold(id)} approved.`),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Approve failed: ${message}`));
        process.exit(1);
      }
    });

  // ── attention reject <id> "reason" ────────────────────────────────

  attention
    .command("reject <id> <reason>")
    .description("Human-reject an escalated item with a reason")
    .action(async (id: string, reason: string) => {
      try {
        const client = createClient();
        await client.rejectAttentionItem(id, reason);
        console.log(chalk.red(`Item ${chalk.bold(id)} rejected.`));
        console.log(chalk.dim(`Reason: ${reason}`));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Reject failed: ${message}`));
        process.exit(1);
      }
    });
}
