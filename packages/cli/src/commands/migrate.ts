import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { ApiClient } from "../lib/api.js";
import { loadConfig, saveConfig, type CliConfig } from "../lib/config.js";

interface ImportResult {
  repoId: string;
  repoName: string;
  namespace: string;
  cloned: boolean;
  branchesImported: number;
  issuesImported: number;
  commentsImported?: number;
  issuesTruncated: boolean;
}

interface ImportJob {
  id: string;
  status: "pending" | "running" | "success" | "failure";
  result: ImportResult | null;
  errorMessage: string | null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Imports run in the background server-side; poll the job until it's terminal.
async function pollImportJob(client: ApiClient, agentToken: string, jobId: string): Promise<ImportResult> {
  for (let i = 0; i < 600; i++) {
    const job = await client.request<ImportJob>("GET", `/api/v1/migrate/jobs/${jobId}`, { token: agentToken });
    if (job.status === "success" && job.result) return job.result;
    if (job.status === "failure") throw new Error(job.errorMessage ?? "import failed");
    await sleep(1500);
  }
  throw new Error("import timed out — check the repo list");
}

// Prompt for a secret on a TTY without echoing it (source PATs are secrets).
async function promptSecret(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = process.stdout;
  const realWrite = (out as unknown as { write: (s: string) => boolean }).write.bind(out);
  let muted = false;
  (out as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => (muted ? true : realWrite(s));
  return new Promise(resolve => {
    rl.question(label, answer => {
      (out as unknown as { write: (s: string) => boolean }).write = realWrite;
      out.write("\n");
      rl.close();
      resolve(answer.trim());
    });
    muted = true;
  });
}

async function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (data += c));
    process.stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
  });
}

// The migrate API is agent-only (the repo is owned by a user/org namespace; the
// importing agent is granted writer). Resolve an agent token: reuse a stored one,
// else mint the logged-in user's personal agent (auto-claimed, so it may import
// into their own handle). A headless caller with neither must `ch init` first.
async function resolveAgentToken(client: ApiClient, cfg: CliConfig): Promise<{ token: string; cfg: CliConfig }> {
  if (cfg.agentToken) return { token: cfg.agentToken, cfg };
  if (cfg.userToken) {
    const r = await client.request<{ agent: { name: string }; owner?: string; token?: string }>(
      "POST", "/api/v1/agents/personal", { tokenKind: "user", body: { rotate: true } },
    );
    if (!r.token) throw new Error("server did not return an agent token");
    const next = { ...cfg, agentToken: r.token, agentName: r.agent.name, ownerHandle: r.owner ?? cfg.ownerHandle };
    saveConfig(next);
    console.log(chalk.gray(`• using your personal agent "${r.agent.name}" to run the import`));
    return { token: r.token, cfg: next };
  }
  console.error(chalk.red("✗ import runs as an agent, and you're not logged in"));
  console.error(chalk.gray("  run ") + chalk.cyan("ch login") + chalk.gray(" (then re-run), or ") + chalk.cyan("ch init") + chalk.gray(" to set up an agent."));
  process.exit(1);
}

// Default destination: the logged-in human's own handle, so an imported repo
// lands under @handle like a normal push. Headless (no handle) → omit, which the
// server maps to the agent's own namespace. `--into` always wins.
function targetNamespace(into: string | undefined, cfg: CliConfig): string | undefined {
  return into ?? cfg.userHandle ?? undefined;
}

function reportResult(r: ImportResult, dashboard: string): void {
  const clone = r.cloned ? `${r.branchesImported} branch${r.branchesImported === 1 ? "" : "es"}` : chalk.yellow("code clone failed — only metadata imported");
  const comments = r.commentsImported === undefined ? "" : `, ${r.commentsImported} comments`;
  console.log(chalk.green(`✓ imported ${r.namespace}/${r.repoName}`));
  console.log(chalk.gray(`  ${clone}, ${r.issuesImported} issues${comments}`));
  if (r.issuesTruncated) console.log(chalk.yellow("  ⚠ issue import was capped at the first ~5,000 — older issues were not imported."));
  console.log(chalk.gray(`  view it at ${dashboard}/${r.namespace}/${r.repoName}`));
}

function dashboardUrl(cfg: CliConfig): string {
  const u = new URL(cfg.server);
  return `${u.protocol}//${u.host.replace(/^api\./, "")}`;
}

export function registerMigrateCommands(program: Command) {
  const g = program.command("import").description("Import an existing repo (code + issues) from GitHub, GitLab, or Bitbucket");

  g.command("github <owner/repo>")
    .description("Import a GitHub repo. Token: --token, --token-stdin, or interactive prompt")
    .option("--token <pat>", "GitHub personal access token (avoid on the CLI — prefer --token-stdin or the prompt)")
    .option("--token-stdin", "read the token from stdin")
    .option("--into <namespace>", "target namespace (default: your account)")
    .option("--as <name>", "target ClawHub repo name (default: source repo name)")
    .option("--no-issues", "skip importing issues")
    .option("--host <host>", "GitHub API host for GitHub Enterprise (default api.github.com)")
    .action(async (slug: string, opts: { token?: string; tokenStdin?: boolean; into?: string; as?: string; issues?: boolean; host?: string }) => {
      const parts = slug.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) { console.error(chalk.red("✗ expected <owner>/<repo>")); process.exit(1); }
      const cfg = loadConfig();
      const client = new ApiClient(cfg);
      const { token: agentToken, cfg: cfg2 } = await resolveAgentToken(client, cfg);
      const ghToken = opts.tokenStdin ? await readStdin() : opts.token ?? await promptSecret("GitHub token: ");
      if (!ghToken) { console.error(chalk.red("✗ a GitHub token is required")); process.exit(1); }
      console.log(chalk.gray(`importing ${parts[0]}/${parts[1]} … (cloning + issues; this can take a minute for a large repo)`));
      const { jobId } = await client.request<{ jobId: string }>("POST", "/api/v1/migrate/github", {
        token: agentToken,
        body: { githubToken: ghToken, sourceOwner: parts[0], sourceRepo: parts[1], targetNamespace: targetNamespace(opts.into, cfg2), targetRepoName: opts.as, includeIssues: opts.issues !== false, includeComments: opts.issues !== false, ghHost: opts.host },
      });
      reportResult(await pollImportJob(client, agentToken, jobId), dashboardUrl(cfg2));
    });

  g.command("gitlab <project-path>")
    .description("Import a GitLab project (e.g. my-group/my-project). Token: --token, --token-stdin, or prompt")
    .option("--token <pat>", "GitLab access token (scope: read_repository + read_api)")
    .option("--token-stdin", "read the token from stdin")
    .option("--into <namespace>", "target namespace (default: your account)")
    .option("--as <name>", "target ClawHub repo name")
    .option("--no-issues", "skip importing issues")
    .option("--host <host>", "GitLab host for self-hosted (default gitlab.com)")
    .action(async (projectPath: string, opts: { token?: string; tokenStdin?: boolean; into?: string; as?: string; issues?: boolean; host?: string }) => {
      if (!projectPath.includes("/")) { console.error(chalk.red("✗ expected a project path like my-group/my-project")); process.exit(1); }
      const cfg = loadConfig();
      const client = new ApiClient(cfg);
      const { token: agentToken, cfg: cfg2 } = await resolveAgentToken(client, cfg);
      const glToken = opts.tokenStdin ? await readStdin() : opts.token ?? await promptSecret("GitLab token: ");
      if (!glToken) { console.error(chalk.red("✗ a GitLab token is required")); process.exit(1); }
      console.log(chalk.gray(`importing ${projectPath} … (cloning + issues; this can take a minute for a large repo)`));
      const { jobId } = await client.request<{ jobId: string }>("POST", "/api/v1/migrate/gitlab", {
        token: agentToken,
        body: { gitlabToken: glToken, projectPath, targetNamespace: targetNamespace(opts.into, cfg2), targetRepoName: opts.as, includeIssues: opts.issues !== false, includeComments: opts.issues !== false, host: opts.host },
      });
      reportResult(await pollImportJob(client, agentToken, jobId), dashboardUrl(cfg2));
    });

  g.command("bitbucket <workspace/slug>")
    .description("Import a Bitbucket repo. Auth: --username + app password (--app-password, --password-stdin, or prompt)")
    .option("--username <user>", "Bitbucket username")
    .option("--app-password <pw>", "Bitbucket app password (scope: repository:read + issue:read)")
    .option("--password-stdin", "read the app password from stdin")
    .option("--into <namespace>", "target namespace (default: your account)")
    .option("--as <name>", "target ClawHub repo name")
    .option("--no-issues", "skip importing issues")
    .action(async (slug: string, opts: { username?: string; appPassword?: string; passwordStdin?: boolean; into?: string; as?: string; issues?: boolean }) => {
      const parts = slug.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) { console.error(chalk.red("✗ expected <workspace>/<repo-slug>")); process.exit(1); }
      if (!opts.username) { console.error(chalk.red("✗ --username is required for Bitbucket")); process.exit(1); }
      const cfg = loadConfig();
      const client = new ApiClient(cfg);
      const { token: agentToken, cfg: cfg2 } = await resolveAgentToken(client, cfg);
      const appPassword = opts.passwordStdin ? await readStdin() : opts.appPassword ?? await promptSecret("Bitbucket app password: ");
      if (!appPassword) { console.error(chalk.red("✗ a Bitbucket app password is required")); process.exit(1); }
      console.log(chalk.gray(`importing ${parts[0]}/${parts[1]} … (cloning + issues; this can take a minute for a large repo)`));
      const { jobId } = await client.request<{ jobId: string }>("POST", "/api/v1/migrate/bitbucket", {
        token: agentToken,
        body: { username: opts.username, appPassword, workspace: parts[0], repoSlug: parts[1], targetNamespace: targetNamespace(opts.into, cfg2), targetRepoName: opts.as, includeIssues: opts.issues !== false },
      });
      reportResult(await pollImportJob(client, agentToken, jobId), dashboardUrl(cfg2));
    });
}
