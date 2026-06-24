import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { parseRepo, resolveIdPrefix } from "../lib/repo.js";
import { loadConfig } from "../lib/config.js";

interface StandingAgent {
  id: string;
  name: string;
  image: string;
  trigger: "manual" | "continuous" | "schedule" | "event";
  cron: string | null;
  event: string | null;
  intervalSec: number;
  llmProvider: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  lastRunAt: string | null;
  hasLlmKey: boolean;
}

const DEFAULT_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  custom: "LLM_API_KEY",
};

function describeTrigger(s: StandingAgent): string {
  switch (s.trigger) {
    case "continuous": return chalk.green(`continuous:${s.intervalSec}s`);
    case "schedule":   return chalk.magenta(`schedule:${s.cron ?? "?"}`) + chalk.gray(" (UTC)");
    case "event":      return chalk.blue(`event:${s.event ?? "?"}`);
    default:           return chalk.gray("manual");
  }
}

// Fetch the repo's standing agents and resolve a user-supplied id prefix to a
// full id (so `ch standing run <ns/repo> a1b2c3d4` works like the list output).
async function resolveStandingId(client: ApiClient, ns: string, repo: string, id: string): Promise<string> {
  const { standingAgents } = await client.request<{ standingAgents: StandingAgent[] }>("GET", `/api/v1/repos/${ns}/${repo}/standing-agents`);
  return resolveIdPrefix(standingAgents, id, "standing agent");
}

export function registerStandingCommands(program: Command) {
  const g = program.command("standing").description("Standing agents — run a BYO AI 24/7 in a repo (see docs/standing-agents.md)");

  g.command("list [ns/repo]")
    .description("List the repo's standing agents")
    .action(async (repoArg?: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const { standingAgents } = await client.request<{ standingAgents: StandingAgent[] }>("GET", `/api/v1/repos/${ns}/${repo}/standing-agents`);
      if (!standingAgents.length) { console.log(chalk.gray("(no standing agents)")); return; }
      for (const s of standingAgents) {
        const state = s.enabled ? chalk.cyan(s.status) : chalk.gray("paused");
        console.log(`${chalk.cyan(s.id.slice(0, 8))} ${chalk.bold(s.name.padEnd(20))} ${describeTrigger(s).padEnd(28)} ${state}  ${chalk.gray(s.image)}`);
        if (s.lastError) console.log(`         ${chalk.red(s.lastError)}`);
      }
    });

  g.command("add [ns/repo]")
    .description("Attach a standing agent to a repo (LLM key read from env, never argv)")
    .requiredOption("--name <name>", "display name (unique in the repo)")
    .requiredOption("--image <image>", "your agent container image")
    .option("--command <cmd>", "command override (else the image ENTRYPOINT)")
    .option("--trigger <kind>", "manual | continuous | schedule | event", "continuous")
    .option("--interval <sec>", "continuous: min seconds between ticks", "3600")
    .option("--cron <expr>", "schedule: 5-field UTC cron")
    .option("--event <type>", "event: ClawHub event type, e.g. change.merged")
    .option("--mode <mode>", "worker | review | triage | reflect (drives memory; CLAWHUB_MODE)", "worker")
    .option("--task <text>", "the prompt/instructions for the agent", "")
    .option("--llm <provider>", "anthropic | openrouter | openai | custom", "anthropic")
    .option("--llm-base-url <url>", "base URL for a proxy / local model")
    .option("--llm-key-env <VAR>", "env var holding the LLM key (default per provider)")
    .option("--no-llm-key", "don't inject an LLM key (local no-auth model / via repo secrets)")
    .option("--agent-name <name>", "use/create a dedicated agent identity instead of your CLI agent token")
    .option("--memory <mb>", "container memory MB", "1024")
    .option("--cpus <n>", "container CPUs", "1")
    .option("--timeout <sec>", "per-run wall-clock timeout", "1800")
    .option("--egress <policy>", "network containment: none (infra only) | allowlist | all", "none")
    .option("--egress-host <host...>", "allowed host(s) when --egress allowlist (repeatable; e.g. example.com '*.test.dev')")
    .action(async (repoArg: string | undefined, opts: Record<string, string | boolean | string[]>) => {
      const { ns, repo } = parseRepo(repoArg);
      const cfg = loadConfig();
      const provider = String(opts.llm);

      // Identity: a dedicated agent name, or the CLI's agent token (sealed
      // server-side so the harness can push as you). Never put a token in argv.
      const body: Record<string, unknown> = {
        name: opts.name, image: opts.image,
        command: opts.command, trigger: opts.trigger,
        intervalSec: Number(opts.interval), cron: opts.cron, event: opts.event,
        mode: opts.mode, task: opts.task, llmProvider: provider, llmBaseUrl: opts.llmBaseUrl,
        memoryMb: Number(opts.memory), cpus: Number(opts.cpus), timeoutSec: Number(opts.timeout),
        egressPolicy: opts.egress,
        egressAllowedHosts: Array.isArray(opts.egressHost) ? opts.egressHost : (opts.egressHost ? [String(opts.egressHost)] : []),
      };
      if (opts.agentName) body.agentName = opts.agentName;
      else {
        if (!cfg.agentToken) { console.error(chalk.red("✗ no agent token in CLI config — run `ch init`, or pass --agent-name")); process.exit(1); }
        body.agentToken = cfg.agentToken;
      }

      // LLM key from the environment (so it never lands in shell history).
      if (opts.llmKey !== false) {
        const keyEnv = String(opts.llmKeyEnv ?? DEFAULT_KEY_ENV[provider] ?? "LLM_API_KEY");
        const key = process.env[keyEnv];
        if (!key) {
          console.error(chalk.red(`✗ ${keyEnv} is not set — export your ${provider} key, or pass --no-llm-key`));
          process.exit(1);
        }
        body.llmApiKey = key;
      }

      const client = new ApiClient();
      const { standingAgent } = await client.request<{ standingAgent: StandingAgent }>("POST", `/api/v1/repos/${ns}/${repo}/standing-agents`, { body, tokenKind: "user" });
      console.log(chalk.green(`✓ standing agent "${standingAgent.name}" attached`) + chalk.gray(` (${standingAgent.id.slice(0, 8)})`));
      console.log(`  ${describeTrigger(standingAgent)}  ${chalk.gray(standingAgent.image)}`);
      if (standingAgent.trigger === "manual") console.log(chalk.gray(`  → fire a tick: ch standing run ${ns}/${repo} ${standingAgent.id.slice(0, 8)}`));
    });

  g.command("run <ns/repo> <id>")
    .description("Fire one tick now (still governance-checked)")
    .action(async (repoArg: string, id: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const fullId = await resolveStandingId(client, ns, repo, id);
      const res = await client.request<{ ok: boolean; runId?: string; reason?: string }>("POST", `/api/v1/repos/${ns}/${repo}/standing-agents/${fullId}/run`, { body: {}, tokenKind: "user" });
      if (res.ok) console.log(chalk.green(`✓ tick dispatched`) + chalk.gray(` (run ${res.runId?.slice(0, 8)})`));
      else console.log(chalk.yellow(`not dispatched: ${res.reason}`));
    });

  g.command("pause <ns/repo> <id>")
    .description("Pause a standing agent")
    .action(async (repoArg: string, id: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const fullId = await resolveStandingId(client, ns, repo, id);
      await client.request("PATCH", `/api/v1/repos/${ns}/${repo}/standing-agents/${fullId}`, { body: { enabled: false }, tokenKind: "user" });
      console.log(chalk.green("✓ paused"));
    });

  g.command("resume <ns/repo> <id>")
    .description("Resume a paused standing agent")
    .action(async (repoArg: string, id: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const fullId = await resolveStandingId(client, ns, repo, id);
      await client.request("PATCH", `/api/v1/repos/${ns}/${repo}/standing-agents/${fullId}`, { body: { enabled: true }, tokenKind: "user" });
      console.log(chalk.green("✓ resumed"));
    });

  g.command("logs <ns/repo> <id>")
    .description("Show the last run's step output")
    .action(async (repoArg: string, id: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const { standingAgents } = await client.request<{ standingAgents: Array<StandingAgent & { lastRunId: string | null }> }>("GET", `/api/v1/repos/${ns}/${repo}/standing-agents`);
      const fullId = resolveIdPrefix(standingAgents, id, "standing agent");
      const sa = standingAgents.find(s => s.id === fullId);
      if (!sa) { console.error(chalk.red(`✗ no standing agent matching "${id}"`)); process.exit(1); }
      if (!sa.lastRunId) { console.log(chalk.gray("(no runs yet)")); return; }
      const { runs } = await client.request<{ runs: Array<{ id: string; status: string; stepResults: Array<{ name?: string; out?: string; err?: string; exitCode?: number }> }> }>("GET", `/api/v1/repos/${ns}/${repo}/ci/runs`);
      const run = runs.find(r => r.id === sa.lastRunId);
      if (!run) { console.log(chalk.gray("(run not found)")); return; }
      console.log(`${chalk.cyan(run.id.slice(0, 8))} ${run.status}`);
      for (const s of run.stepResults ?? []) {
        console.log(chalk.bold(`\n— ${s.name ?? "step"} (exit ${s.exitCode ?? "?"})`));
        if (s.out) console.log(s.out);
        if (s.err) console.log(chalk.red(s.err));
      }
    });

  g.command("rm <ns/repo> <id>")
    .description("Remove a standing agent")
    .action(async (repoArg: string, id: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const fullId = await resolveStandingId(client, ns, repo, id);
      await client.request("DELETE", `/api/v1/repos/${ns}/${repo}/standing-agents/${fullId}`, { tokenKind: "user" });
      console.log(chalk.green("✓ removed"));
    });
}
