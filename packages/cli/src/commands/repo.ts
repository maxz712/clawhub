import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { loadConfig } from "../lib/config.js";
import { parseRepo } from "../lib/repo.js";

// The merge-policy subset the dashboard + solo-mode preset care about. Other
// fields exist on the server (trusted agents, merge methods, path overrides) but
// we summarize only the governance knobs a human tunes day-to-day.
interface MergePolicy {
  requireHumanApproval?: "always" | "never" | "if_risk_at_least";
  requireHumanApprovalLevel?: string;
  ciRequired?: boolean;
  allowSelfReview?: boolean;
  codeReviewRequiredAtRisk?: string;
}

interface Repo {
  id: string;
  name: string;
  defaultBranch: string;
  isPublic: boolean;
  mergePolicy?: MergePolicy;
  // The list endpoint returns raw rows (namespaceType/namespaceId only); the
  // detail endpoint returns a sibling `namespace`. Tolerate both.
  namespaceName?: string;
}

interface Namespace { kind: "agent" | "org" | "user"; id: string; name: string }

function vis(isPublic: boolean): string {
  return isPublic ? chalk.green("public") : chalk.gray("private");
}

// One-line, human-readable read of the merge policy: when a human is required,
// whether CI gates, and whether the author can approve their own work (the
// solo-mode tell).
function describePolicy(mp: MergePolicy | undefined): string[] {
  if (!mp) return [chalk.gray("  (default policy)")];
  const lines: string[] = [];

  let humanAt: string;
  if (mp.requireHumanApproval === "always") humanAt = "always";
  else if (mp.requireHumanApproval === "never") humanAt = "never";
  else humanAt = `risk ≥ ${mp.requireHumanApprovalLevel ?? "high"}`;
  lines.push(`  ${chalk.gray("human approval:")} ${humanAt}`);

  lines.push(`  ${chalk.gray("ci required:")}    ${mp.ciRequired === false ? "no" : "yes"}`);

  const solo = mp.allowSelfReview === true;
  lines.push(`  ${chalk.gray("solo mode:")}      ${solo ? chalk.green("on") + chalk.gray(" (author can approve their own low/medium work)") : chalk.gray("off")}`);

  return lines;
}

export function registerRepoCommands(program: Command) {
  const g = program.command("repo").description("Inspect + configure your repos");

  g.command("list")
    .description("List the repos you can see (your agent's namespace, claimed agents, and your orgs)")
    .action(async () => {
      const client = new ApiClient();
      const cfg = loadConfig();
      const { repos } = await client.request<{ repos: Repo[] }>("GET", "/api/v1/repos");
      if (!repos.length) {
        console.log(chalk.gray("(no repos)"));
        console.log(chalk.gray("  push your first repo: ") + chalk.cyan("ch init") + chalk.gray(" then ") + chalk.cyan("git push -u origin main") + chalk.gray("."));
        return;
      }
      for (const r of repos) {
        // The list endpoint omits a namespace name; fall back to the configured
        // agent name (the common case: an agent listing its own repos), else "?".
        const ns = r.namespaceName ?? cfg?.agentName ?? "?";
        console.log(`${chalk.cyan(`${ns}/${r.name}`)}  ${chalk.gray(r.defaultBranch)}  ${vis(r.isPublic)}`);
      }
    });

  g.command("view [ns/repo]")
    .description("Show a repo's branch, visibility, and merge-policy summary")
    .action(async (repoArg?: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const { repo: r, namespace } = await client.request<{ repo: Repo; namespace: Namespace }>("GET", `/api/v1/repos/${ns}/${repo}`);
      console.log(chalk.bold(`${namespace.name}/${r.name}`));
      console.log(`${chalk.gray("default branch:")} ${r.defaultBranch}`);
      console.log(`${chalk.gray("visibility:")}     ${vis(r.isPublic)}`);
      console.log(chalk.gray("merge policy:"));
      for (const line of describePolicy(r.mergePolicy)) console.log(line);
    });

  g.command("solo-mode [ns/repo]")
    .description("Enable Solo mode: let the author approve their own low/medium work (keeps sensitive-path + high-risk backstops)")
    .action(async (repoArg?: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const { mergePolicy } = await client.request<{ ok: boolean; mergePolicy: MergePolicy }>("POST", `/api/v1/repos/${ns}/${repo}/merge-policy/solo-mode`);
      console.log(chalk.green(`✓ solo mode enabled for ${ns}/${repo}`));
      console.log(chalk.gray("merge policy:"));
      for (const line of describePolicy(mergePolicy)) console.log(line);
      console.log(chalk.gray("  note: sensitive paths (migrations, *.sql, deploy/**, Dockerfile, compose, policies) and high/critical-risk changes still require a human who reviewed the code."));
    });

  g.command("transfer <ns/repo> <to>")
    .description("Transfer a repo to a user or org namespace you control (relocates the repo; update your git remote afterward)")
    .action(async (repoArg: string, to: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const r = await client.request<{ ok: boolean; namespace: { kind: string; name: string } }>(
        "POST", `/api/v1/repos/${ns}/${repo}/transfer`, { tokenKind: "user", body: { to } },
      );
      const cfg = loadConfig();
      const host = new URL(cfg.server).host;
      console.log(chalk.green(`✓ ${ns}/${repo} → ${r.namespace.name}/${repo}`));
      console.log(chalk.yellow("  update your git remote so pushes find the new path:"));
      console.log(chalk.cyan(`  git remote set-url origin https://agent-token:<token>@${host}/${r.namespace.name}/${repo}.git`));
    });
}
