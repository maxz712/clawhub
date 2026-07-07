import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { resolveIdPrefix } from "../lib/repo.js";

interface Workflow {
  id: string;
  standingAgentId: string;
  name: string;
  instructions: string;
  trigger: "manual" | "continuous" | "schedule" | "event";
  cron: string | null;
  event: string | null;
  intervalSec: number;
  repoScope: "all" | "selected";
  repoIds: string[];
  enabled: boolean;
  agentName?: string;
  deploymentName?: string;
}

function describeTrigger(w: Workflow): string {
  switch (w.trigger) {
    case "continuous": return chalk.green(`continuous:${w.intervalSec}s`);
    case "schedule":   return chalk.magenta(`schedule:${w.cron ?? "?"}`) + chalk.gray(" (UTC)");
    case "event":      return chalk.blue(`event:${w.event ?? "?"}`);
    default:           return chalk.gray("manual");
  }
}

async function resolveWorkflowId(client: ApiClient, id: string): Promise<string> {
  const { workflows } = await client.request<{ workflows: Workflow[] }>("GET", "/api/v1/workflows");
  return resolveIdPrefix(workflows, id, "workflow");
}

async function resolveStandingAgentId(client: ApiClient, id: string): Promise<string> {
  const { standingAgents } = await client.request<{ standingAgents: Array<{ id: string }> }>("GET", "/api/v1/standing-agents");
  return resolveIdPrefix(standingAgents, id, "standing agent (deployment)");
}

export function registerWorkflowCommands(program: Command) {
  const g = program.command("workflow").description("Workflows — give standing agents work to do (see docs/redesign-v4.md)");

  g.command("list")
    .description("List your workflows")
    .action(async () => {
      const client = new ApiClient();
      const { workflows } = await client.request<{ workflows: Workflow[] }>("GET", "/api/v1/workflows");
      if (!workflows.length) { console.log(chalk.gray("(no workflows)")); return; }
      for (const w of workflows) {
        const state = w.enabled ? chalk.cyan("enabled") : chalk.gray("paused");
        const agent = w.agentName ? `@${w.agentName}` : `deployment:${w.standingAgentId.slice(0, 8)}`;
        console.log(`${chalk.cyan(w.id.slice(0, 8))} ${chalk.bold(w.name.padEnd(25))} ${agent.padEnd(20)} ${describeTrigger(w).padEnd(28)} ${state}`);
        if (w.instructions) console.log(`         ${chalk.gray(w.instructions)}`);
      }
    });

  g.command("add")
    .description("Create a new workflow")
    .requiredOption("--name <name>", "display name")
    .requiredOption("--agent-id <id>", "standing agent (deployment) full or short ID")
    .option("--instructions <text>", "instructions (starts with slash flag /dev, /loop or custom text)", "/loop")
    .option("--trigger <kind>", "manual | continuous | schedule | event", "manual")
    .option("--cron <expr>", "schedule: 5-field UTC cron")
    .option("--event <type>", "event: ClawHub event type, e.g. change.opened")
    .option("--interval <sec>", "continuous: min seconds between ticks", "3600")
    .option("--repo-scope <scope>", "all | selected", "all")
    .option("--repo-id <id...>", "repo UUID(s) when --repo-scope is selected (repeatable)")
    .action(async (opts: Record<string, string | boolean | string[]>) => {
      const client = new ApiClient();
      const fullAgentId = await resolveStandingAgentId(client, String(opts.agentId));

      const repoIds = Array.isArray(opts.repoId) ? opts.repoId : (opts.repoId ? [String(opts.repoId)] : []);
      const body = {
        name: opts.name,
        standingAgentId: fullAgentId,
        instructions: opts.instructions,
        trigger: opts.trigger,
        cron: opts.cron || null,
        event: opts.event || null,
        intervalSec: Number(opts.interval),
        repoScope: opts.repoScope,
        repoIds,
        enabled: true,
      };

      const { workflow } = await client.request<{ workflow: Workflow }>("POST", "/api/v1/workflows", { body, tokenKind: "user" });
      console.log(chalk.green(`✓ workflow "${workflow.name}" created`) + chalk.gray(` (${workflow.id.slice(0, 8)})`));
      console.log(`  trigger: ${describeTrigger(workflow)}`);
    });

  g.command("run <id>")
    .description("Trigger one execution of the workflow now")
    .option("--repo-id <id>", "override default repo scope with a specific repo UUID")
    .action(async (id: string, opts: { repoId?: string }) => {
      const client = new ApiClient();
      const fullId = await resolveWorkflowId(client, id);
      const body = opts.repoId ? { repoId: opts.repoId } : {};
      const res = await client.request<{ dispatched: number; results: Array<{ repoId: string; ok: boolean; reason?: string }> }>(
        "POST", `/api/v1/workflows/${fullId}/run`, { body, tokenKind: "user" }
      );
      if (res.dispatched > 0) {
        console.log(chalk.green(`✓ workflow dispatched to ${res.dispatched} repo(s)`));
      } else {
        console.log(chalk.yellow(`not dispatched: no repos in scope were eligible.`));
      }
    });

  g.command("pause <id>")
    .description("Pause a workflow")
    .action(async (id: string) => {
      const client = new ApiClient();
      const fullId = await resolveWorkflowId(client, id);
      await client.request("PATCH", `/api/v1/workflows/${fullId}`, { body: { enabled: false }, tokenKind: "user" });
      console.log(chalk.green("✓ paused"));
    });

  g.command("resume <id>")
    .description("Resume a paused workflow")
    .action(async (id: string) => {
      const client = new ApiClient();
      const fullId = await resolveWorkflowId(client, id);
      await client.request("PATCH", `/api/v1/workflows/${fullId}`, { body: { enabled: true }, tokenKind: "user" });
      console.log(chalk.green("✓ resumed"));
    });

  g.command("rm <id>")
    .description("Remove a workflow")
    .action(async (id: string) => {
      const client = new ApiClient();
      const fullId = await resolveWorkflowId(client, id);
      await client.request("DELETE", `/api/v1/workflows/${fullId}`, { tokenKind: "user" });
      console.log(chalk.green("✓ removed"));
    });
}
