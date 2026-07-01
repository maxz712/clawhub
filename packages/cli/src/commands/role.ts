import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { resolveIdPrefix } from "../lib/repo.js";

interface Role {
  id: string; name: string; capability: string; specialization: string | null;
  image: string; mode: string; trigger: string; earnedAutonomy: boolean;
  ownerType: string; slug?: string | null; description?: string | null; hasLlmKey?: boolean;
}

const DEFAULT_KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY", openai: "OPENAI_API_KEY", custom: "LLM_API_KEY" };
// One-step setup: the user picks a CLI and supplies ONE credential. These are the
// env vars each CLI's credential is read from (mirrors api CLI_KEY_ENVS).
const DEFAULT_CLI_KEY_ENV: Record<string, string> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", copilot: "GITHUB_TOKEN" };
const CAP_COLOR: Record<string, (s: string) => string> = { worker: chalk.green, reviewer: chalk.blue, triager: chalk.magenta, specialist: chalk.cyan };

function renderRole(r: Role) {
  const cap = (CAP_COLOR[r.capability] ?? chalk.white)(r.capability.padEnd(10));
  const spec = r.specialization ? chalk.gray(`/${r.specialization}`) : "";
  const auto = r.earnedAutonomy ? chalk.yellow(" ⚡earns-autonomy") : "";
  console.log(`${chalk.cyan((r.id ?? r.slug ?? "").slice(0, 8))} ${cap}${spec} ${chalk.bold(r.name)}${auto}`);
  if (r.description) console.log(`         ${chalk.gray(r.description)}`);
}

// Resolve a user-supplied role id prefix to a full id by listing the caller's
// roles (so `ch role deploy a1b2c3d4 …` works like the list output). An org id
// scopes the lookup when the role is org-owned.
async function resolveRoleId(client: ApiClient, id: string, org?: string): Promise<string> {
  const q = org ? `?org=${org}` : "";
  const { roles } = await client.request<{ roles: Role[] }>("GET", `/api/v1/roles${q}`, { tokenKind: "user" });
  return resolveIdPrefix(roles, id, "role");
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
    .option("--mode <mode>", "worker | develop | review | verify | triage | reflect (defaults from capability)")
    .option("--trigger <kind>", "manual | continuous | schedule | event")
    .option("--cron <expr>", "schedule cron (5-field UTC)")
    .option("--event <type>", "event type, e.g. change.opened")
    .option("--task <text>", "the prompt/instructions")
    .option("--llm <provider>", "anthropic | openrouter | openai | custom", "anthropic")
    .option("--cli <cli>", "coding-agent CLI: claude | copilot | codex | gemini", "claude")
    .option("--model <name>", "pin the CLI model (e.g. sonnet | opus); omit for the CLI default")
    .option("--llm-key-env <VAR>", "env var with the credential (default per CLI)")
    .option("--earned-autonomy", "let this role's agent earn low-risk self-merge once proven")
    .option("--org <id>", "create as an org-owned role (org admin)")
    .action(async (opts: Record<string, string | boolean>) => {
      const provider = String(opts.llm);
      const cli = String(opts.cli ?? "claude");
      const body: Record<string, unknown> = {
        template: opts.template, name: opts.name, capability: opts.capability,
        specialization: opts.specialization, image: opts.image, mode: opts.mode,
        trigger: opts.trigger, cron: opts.cron, event: opts.event, task: opts.task,
        llmProvider: provider, cli, model: opts.model, earnedAutonomy: !!opts.earnedAutonomy,
      };
      if (opts.org) body.org = opts.org;
      // Credential resolution favors the CLI (the one-step path): pick a CLI, set
      // its key env var, done. --llm-key-env overrides; provider is the fallback.
      const keyEnv = String(opts.llmKeyEnv ?? DEFAULT_CLI_KEY_ENV[cli] ?? DEFAULT_KEY_ENV[provider] ?? "LLM_API_KEY");
      const key = process.env[keyEnv];
      if (key) body.llmApiKey = key;
      else console.error(chalk.yellow(`(no ${keyEnv} in env — role created without a ${cli} credential; set one before deploying)`));
      const { role } = await new ApiClient().request<{ role: Role }>("POST", "/api/v1/roles", { body, tokenKind: "user" });
      console.log(chalk.green(`✓ role "${role.name}" created`) + chalk.gray(` (${role.id.slice(0, 8)})`));
      console.log(`  deploy it: ${chalk.cyan(`ch role deploy ${role.id.slice(0, 8)} --repo <ns/repo>`)} ${chalk.gray("or")} ${chalk.cyan(`--org <id>`)}`);
    });

  g.command("verified-reviewer")
    .description("One-step: create a verified-reviewer (your CLI + credential) and deploy it to a repo")
    .requiredOption("--repo <ns/repo>", "repo to deploy the reviewer to")
    .option("--cli <cli>", "coding-agent CLI: claude | copilot | codex | gemini", "claude")
    .option("--model <name>", "pin the CLI model (e.g. sonnet | opus); omit for the CLI default")
    .option("--llm-key-env <VAR>", "env var with the credential (default per CLI)")
    .option("--org <id>", "create as an org-owned role (org admin)")
    .action(async (opts: Record<string, string>) => {
      const cli = String(opts.cli ?? "claude");
      const keyEnv = String(opts.llmKeyEnv ?? DEFAULT_CLI_KEY_ENV[cli] ?? "LLM_API_KEY");
      const key = process.env[keyEnv];
      if (!key) { console.error(chalk.red(`no ${keyEnv} in env — set your ${cli} credential first (e.g. export ${keyEnv}=…)`)); process.exit(1); }
      const body: Record<string, unknown> = { template: "verified-reviewer", cli, llmApiKey: key };
      if (opts.model) body.model = opts.model;
      if (opts.org) body.org = opts.org;
      const client = new ApiClient();
      const { role } = await client.request<{ role: Role }>("POST", "/api/v1/roles", { body, tokenKind: "user" });
      await client.request("POST", `/api/v1/roles/${role.id}/deploy`, { body: { repo: opts.repo }, tokenKind: "user" });
      console.log(chalk.green(`✓ verified reviewer deployed to ${opts.repo}`) + chalk.gray(` (${cli})`));
      console.log(chalk.gray("  It reviews + runs every Change e2e and attaches screenshot evidence."));
      console.log(chalk.gray("  For hands-off auto-merge, enable verifiedAutonomy + autoMergeOnVerified on the repo's merge policy."));
      console.log(chalk.yellow("  ⚠ verified autonomy lets the agent merge with NO human — incl. sensitive paths if you set no floor."));
    });

  g.command("developer")
    .description("One-step: create an autonomous UI developer (your CLI + credential) and deploy it to a repo")
    .requiredOption("--repo <ns/repo>", "repo to deploy the developer to")
    .option("--cli <cli>", "coding-agent CLI: claude | copilot | codex | gemini", "claude")
    .option("--model <name>", "pin the CLI model (e.g. sonnet | opus); omit for the CLI default")
    .option("--task <text>", "a specific feature to build (omit to grab assigned issues e2e)")
    .option("--llm-key-env <VAR>", "env var with the credential (default per CLI)")
    .option("--org <id>", "create as an org-owned role (org admin)")
    .action(async (opts: Record<string, string>) => {
      const cli = String(opts.cli ?? "claude");
      const keyEnv = String(opts.llmKeyEnv ?? DEFAULT_CLI_KEY_ENV[cli] ?? "LLM_API_KEY");
      const key = process.env[keyEnv];
      if (!key) { console.error(chalk.red(`no ${keyEnv} in env — set your ${cli} credential first (e.g. export ${keyEnv}=…)`)); process.exit(1); }
      // Pass --task onto the ROLE: createRole flows it to the deployed agent's task
      // (→ CLAWHUB_TASK → run_develop builds it). No --task ⇒ empty task ⇒ grab issues.
      const body: Record<string, unknown> = { template: "developer", cli, llmApiKey: key };
      if (opts.model) body.model = opts.model;
      if (opts.task) body.task = opts.task;
      if (opts.org) body.org = opts.org;
      const client = new ApiClient();
      const { role } = await client.request<{ role: Role }>("POST", "/api/v1/roles", { body, tokenKind: "user" });
      await client.request("POST", `/api/v1/roles/${role.id}/deploy`, { body: { repo: opts.repo }, tokenKind: "user" });
      console.log(chalk.green(`✓ UI developer deployed to ${opts.repo}`) + chalk.gray(` (${cli})`));
      console.log(chalk.gray(opts.task
        ? "  It builds your task end-to-end and verifies it by looking at + clicking the real UI."
        : "  It grabs assigned issues and builds them end-to-end, verifying each in a real browser."));
      console.log(chalk.gray("  Goal = a prompt (--task) OR an assigned issue (?assigned=me). No human until review."));
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
      const client = new ApiClient();
      const fullId = await resolveRoleId(client, id, opts.org);
      const r = await client.request<{ deployed: number; alreadyDeployed?: number; skipped?: Array<{ repo: string; reason: string }> }>("POST", `/api/v1/roles/${fullId}/deploy`, { body, tokenKind: "user" });
      console.log(chalk.green(`✓ deployed to ${r.deployed} repo(s)`));
      if (r.alreadyDeployed) console.log(chalk.gray(`  ${r.alreadyDeployed} already deployed (skipped)`));
      for (const s of r.skipped ?? []) console.log(chalk.yellow(`  skipped ${s.repo}: ${s.reason}`));
    });

  g.command("deployments <id>")
    .description("List where a role is deployed")
    .action(async (id: string) => {
      const client = new ApiClient();
      const fullId = await resolveRoleId(client, id);
      const { deployments } = await client.request<{ deployments: Array<{ id: string; repoId: string; name: string; status: string; enabled: boolean }> }>("GET", `/api/v1/roles/${fullId}/deployments`, { tokenKind: "user" });
      if (!deployments.length) { console.log(chalk.gray("(not deployed)")); return; }
      for (const d of deployments) console.log(`${chalk.cyan(d.id.slice(0, 8))} ${d.enabled ? chalk.green(d.status) : chalk.gray("paused")} repo:${d.repoId.slice(0, 8)}`);
    });

  g.command("undeploy <id>")
    .description("Remove a role's deployments (optionally one --repo)")
    .option("--repo <ns/repo>", "only this repo")
    .action(async (id: string, opts: Record<string, string>) => {
      const q = opts.repo ? `?repo=${encodeURIComponent(opts.repo)}` : "";
      const client = new ApiClient();
      const fullId = await resolveRoleId(client, id);
      const r = await client.request<{ removed: number }>("DELETE", `/api/v1/roles/${fullId}/deployments${q}`, { tokenKind: "user" });
      console.log(chalk.green(`✓ removed ${r.removed} deployment(s)`));
    });

  g.command("rm <id>")
    .description("Delete a role (and all its deployments)")
    .action(async (id: string) => {
      const client = new ApiClient();
      const fullId = await resolveRoleId(client, id);
      await client.request("DELETE", `/api/v1/roles/${fullId}`, { tokenKind: "user" });
      console.log(chalk.green("✓ role deleted"));
    });
}
