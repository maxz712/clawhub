import { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../lib/api-client.js";

interface AgentRecord {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface ActivityRecord {
  id: string;
  type?: string;
  action?: string;
  repoId?: string;
  changeId?: string;
  timestamp?: string;
  createdAt?: string;
  [key: string]: unknown;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

export function registerAgentCommands(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage agents");

  agent
    .command("list")
    .description("List all registered agents")
    .action(async () => {
      try {
        const client = createClient();
        const result = (await client.listAgents()) as AgentRecord[] | { agents: AgentRecord[] };

        const agents: AgentRecord[] = Array.isArray(result)
          ? result
          : (result as { agents: AgentRecord[] }).agents ?? [];

        if (agents.length === 0) {
          console.log(chalk.dim("No agents found."));
          return;
        }

        console.log(chalk.bold("\n  Agents\n"));
        console.log(
          chalk.dim("  ID".padEnd(40)) +
          chalk.dim("Name".padEnd(25)) +
          chalk.dim("Type".padEnd(15)) +
          chalk.dim("Status".padEnd(12)) +
          chalk.dim("Created")
        );
        console.log(chalk.dim("  " + "—".repeat(95)));

        for (const a of agents) {
          console.log(
            `  ${(a.id ?? "").toString().padEnd(38)}` +
            `${(a.name ?? "—").padEnd(25)}` +
            `${(a.type ?? "—").padEnd(15)}` +
            `${(a.status ?? "—").padEnd(12)}` +
            `${formatDate(a.createdAt)}`
          );
        }
        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to list agents: ${message}`));
        process.exit(1);
      }
    });

  agent
    .command("log <id>")
    .description("Show activity log for an agent")
    .action(async (id: string) => {
      try {
        const client = createClient();
        const result = (await client.getAgentActivity(id)) as ActivityRecord[] | { events: ActivityRecord[] };

        const events: ActivityRecord[] = Array.isArray(result)
          ? result
          : (result as { events: ActivityRecord[] }).events ?? [];

        if (events.length === 0) {
          console.log(chalk.dim("No activity found for this agent."));
          return;
        }

        console.log(chalk.bold(`\n  Activity for agent ${id}\n`));

        for (const event of events) {
          const time = formatDate(event.timestamp ?? event.createdAt);
          const action = event.action ?? event.type ?? "unknown";
          const detail = event.repoId
            ? `repo:${event.repoId}${event.changeId ? ` change:${event.changeId}` : ""}`
            : "";

          console.log(
            `  ${chalk.dim(time)}  ${chalk.cyan(action.padEnd(20))} ${chalk.dim(detail)}`
          );
        }
        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to get agent log: ${message}`));
        process.exit(1);
      }
    });

  agent
    .command("scope <id> <pattern>")
    .description("Set file-scope permissions for an agent (glob pattern)")
    .action(async (id: string, pattern: string) => {
      try {
        const client = createClient();
        await client.updateAgentPermissions(id, { filePatterns: [pattern] });
        console.log(
          chalk.green(`Permissions updated for agent ${chalk.bold(id)}.`) +
          `\n  Scope: ${chalk.cyan(pattern)}`
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to update permissions: ${message}`));
        process.exit(1);
      }
    });
}
