import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";

interface Role {
  id: string; name: string; capability: string; specialization: string | null;
  image: string; mode: string; trigger: string; earnedAutonomy: boolean;
  ownerType: string; slug?: string | null; description?: string | null; hasLlmKey?: boolean;
}

const DEFAULT_KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY", openai: "OPENAI_API_KEY", custom: "LLM_API_KEY" };
const CAP_COLOR: Record<string, (s: string) => string> = { worker: chalk.green, reviewer: chalk.blue, triager: chalk.magenta, specialist: chalk.cyan };

function renderRole(r: Role) {
  const cap = (CAP_COLOR[r.capability] ?? chalk.white)(r.capability.padEnd(10));
  const spec = r.specialization ? chalk.gray(`/${r.specialization}`) : "";
  const auto = r.earnedAutonomy ? chalk.yellow(" ⚡earns-autonomy") : "";
  console.log(`${chalk.cyan((r.id ?? r.slug ?? "").slice(0, 8))} ${cap}${spec} ${chalk.bold(r.name)}${auto}`);
  if (r.description) console.log(`         ${chalk.gray(r.description)}`);
}

export function registerRoleCommands(program: Command) {
  const g = program.command("role").description("Agent roles — deploy worker/reviewer/specialist agents (see docs/agent-roles.md)");

  g.command("templates")
    .description("List the curated role templates (the marketplace)")
    .action(async () => {
      const { templates } = await new ApiClient().request<{ templates: Role[] }>("GET", "/api/v1/roles/templates");
      if (!templates.length) { console.log(chalk.gray("(no templates)")); return; }
      for (const t of templates) renderRole(t);
    });

  g.command("list")
    .description("List your roles (or an org's with --org)")
    .option("--org <id>", "list an org's roles")
    .action(async (opts: Record<string, string>) => {
      const q = opts.org ? `?org=${opts.org}` : "";
      const { roles } = await new ApiClient().request<{ roles: Role[] }>("GET", `/api/v1/roles${q}`, { tokenKind: "user" });
      if (!roles.length) { console.log(chalk.gray("(no roles)")); return; }
      for (const r of roles) renderRole(r);
    });

  g.command("create")
    .description("Create a role (from a --template or custom). LLM key read from env.")
    .option("--template <slug>", "clone a curated template (worker, security-reviewer, …)")
    .option("--name <name>", "display name")
    .option("--capability <cap>", "worker | reviewer | triager | specialist")
    .option("--specialization <s>", "e.g. security, performance, deps")
    .option("--image <image>", "container image (defaults to the reference harness)")
    .option("--mode <mode>", "worker | review | triage | reflect (defaults from capability)")
    .option("--trigger <kind>", "manual | continuous | schedule | event")
    .option("--cron <expr>", "schedule cron (5-field UTC)")
    .option("--event <type>", "event type, e.g. change.opened")
    .option("--task <text>", "the prompt/instructions")
    .option("--llm <provider>", "anthropic | openrouter | openai | custom", "anthropic")
    .option("--llm-key-env <VAR>", "env var with the LLM key (default per provider)")
    .option("--earned-autonomy", "let this role's agent earn low-risk self-merge once proven")
    .option("--org <id>", "create as an org-owned role (org admin)")
    .action(async (opts: Record<string, string | boolean>) => {
      const provider = String(opts.llm);
      const body: Record<string, unknown> = {
        template: opts.template, name: opts.name, capability: opts.capability,
        specialization: opts.specialization, image: opts.image, mode: opts.mode,
        trigger: opts.trigger, cron: opts.cron, event: opts.event, task: opts.task,
        llmProvider: provider, earnedAutonomy: !!opts.earnedAutonomy,
      };
      if (opts.org) body.org = opts.org;
      const keyEnv = String(opts.llmKeyEnv ?? DEFAULT_KEY_ENV[provider] ?? "LLM_API_KEY");
      const key = process.env[keyEnv];
      if (key) body.llmApiKey = key;
      else console.error(chalk.yellow(`(no ${keyEnv} in env — role created without an LLM key; set one before deploying)`));
      const { role } = await new ApiClient().request<{ role: Role }>("POST", "/api/v1/roles", { body, tokenKind: "user" });
      console.log(chalk.green(`✓ role "${role.name}" created`) + chalk.gray(` (${role.id.slice(0, 8)})`));
      console.log(`  deploy it: ${chalk.cyan(`ch role deploy ${role.id.slice(0, 8)} --repo <ns/repo>`)} ${chalk.gray("or")} ${chalk.cyan(`--org <id>`)}`);
    });

  g.command("deploy <id>")
    .description("Deploy a role to a repo (--repo) or across an org (--org)")
    .option("--repo <ns/repo>", "deploy to one repo")
    .option("--org <id>", "fan out across an org's repos")
    .option("--topic <topic>", "org: only repos with this topic")
    .action(async (id: string, opts: Record<string, string>) => {
      const body: Record<string, unknown> = {};
      if (opts.repo) body.repo = opts.repo;
      else if (opts.org) { body.org = opts.org; if (opts.topic) body.topic = opts.topic; }
      else { console.error(chalk.red("✗ pass --repo <ns/repo> or --org <id>")); process.exit(1); }
      const r = await new ApiClient().request<{ deployed: number; alreadyDeployed?: number; skipped?: Array<{ repo: string; reason: string }> }>("POST", `/api/v1/roles/${id}/deploy`, { body, tokenKind: "user" });
      console.log(chalk.green(`✓ deployed to ${r.deployed} repo(s)`));
      if (r.alreadyDeployed) console.log(chalk.gray(`  ${r.alreadyDeployed} already deployed (skipped)`));
      for (const s of r.skipped ?? []) console.log(chalk.yellow(`  skipped ${s.repo}: ${s.reason}`));
    });

  g.command("deployments <id>")
    .description("List where a role is deployed")
    .action(async (id: string) => {
      const { deployments } = await new ApiClient().request<{ deployments: Array<{ id: string; repoId: string; name: string; status: string; enabled: boolean }> }>("GET", `/api/v1/roles/${id}/deployments`, { tokenKind: "user" });
      if (!deployments.length) { console.log(chalk.gray("(not deployed)")); return; }
      for (const d of deployments) console.log(`${chalk.cyan(d.id.slice(0, 8))} ${d.enabled ? chalk.green(d.status) : chalk.gray("paused")} repo:${d.repoId.slice(0, 8)}`);
    });

  g.command("undeploy <id>")
    .description("Remove a role's deployments (optionally one --repo)")
    .option("--repo <ns/repo>", "only this repo")
    .action(async (id: string, opts: Record<string, string>) => {
      const q = opts.repo ? `?repo=${encodeURIComponent(opts.repo)}` : "";
      const r = await new ApiClient().request<{ removed: number }>("DELETE", `/api/v1/roles/${id}/deployments${q}`, { tokenKind: "user" });
      console.log(chalk.green(`✓ removed ${r.removed} deployment(s)`));
    });

  g.command("rm <id>")
    .description("Delete a role (and all its deployments)")
    .action(async (id: string) => {
      await new ApiClient().request("DELETE", `/api/v1/roles/${id}`, { tokenKind: "user" });
      console.log(chalk.green("✓ role deleted"));
    });
}
