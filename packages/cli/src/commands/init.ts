import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import path from "node:path";
import { ApiClient } from "../lib/api.js";
import { loadConfig, saveConfig, type CliConfig } from "../lib/config.js";

function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function defaultRepoName(repoArg?: string): string {
  return (repoArg ?? path.basename(process.cwd())).replace(/\.git$/, "");
}

// Find-or-create a personal agent for a logged-in user, auto-claimed to their
// account. We only reach here when this machine has no agent token, so we ask
// the server to mint a fresh one (rotate:true) — this is the one place that's
// appropriate, since a token is never stored server-side to hand back.
async function ensurePersonalAgent(client: ApiClient, cfg: CliConfig): Promise<CliConfig> {
  const r = await client.request<{ agent: { id: string; name: string }; token?: string; created: boolean }>(
    "POST", "/api/v1/agents/personal", { tokenKind: "user", body: { rotate: true } },
  );
  if (!r.token) throw new Error("server did not return an agent token");
  const next = { ...cfg, agentToken: r.token, agentName: r.agent.name };
  saveConfig(next);
  const verb = r.created ? "created" : "token refreshed for";
  console.log(chalk.green(`✓ personal agent "${r.agent.name}" ${verb} (auto-claimed to your account)`));
  if (!r.created) console.log(chalk.gray("  note: this refreshed the token — other machines using this agent will need to re-init."));
  return next;
}

// Register a brand-new agent for an unauthenticated caller. Surfaces the
// one-time claim token + its ~48h expiry so a human can adopt the agent later.
// Returns the claim token (if any) so the caller can re-surface the "this agent
// is unclaimed" guidance in the Next: block.
async function registerNewAgent(client: ApiClient, cfg: CliConfig, repoName: string): Promise<{ cfg: CliConfig; claimToken?: string }> {
  const name = `${repoName}-agent`;
  const r = await client.request<{ agent: { id: string; name: string }; token: string; claim_token: string; claim_token_expires_at?: string }>(
    "POST", "/api/v1/agents", { body: { name } },
  );
  const next = { ...cfg, agentToken: r.token, agentName: r.agent.name };
  saveConfig(next);
  console.log(chalk.green(`✓ agent "${r.agent.name}" registered`));
  if (r.claim_token) {
    const expiry = r.claim_token_expires_at
      ? ` (expires ${new Date(r.claim_token_expires_at).toLocaleString()})`
      : " (expires in ~48h)";
    console.log(chalk.gray("claim_token: ") + r.claim_token + chalk.yellow(expiry));
    console.log(chalk.gray("  a human runs ") + chalk.cyan(`ch agents claim ${r.claim_token}`) + chalk.gray(" (or uses the dashboard) to adopt this agent."));
  }
  console.log(chalk.gray("  agent name taken? re-run with a directory whose basename is unique, or ") + chalk.cyan("ch agents register <name>") + chalk.gray("."));
  return { cfg: next, claimToken: r.claim_token };
}

export function registerInitCommand(program: Command) {
  program.command("init [repo-name]")
    .description("Bootstrap the current directory: ensure an agent, git repo, and push remote")
    .action(async (repoArg?: string) => {
      let cfg = loadConfig();
      const client = new ApiClient(cfg);
      const repoName = defaultRepoName(repoArg);

      // Tracks the unclaimed-agent state so the Next: block can warn that medium+
      // risk changes will dead-end without a human to approve. Set only on the
      // registerNewAgent path (a logged-out caller); auto-claimed agents skip it.
      let unclaimed: { claimToken?: string } | null = null;

      // (b) Ensure we have an agent token. Logged-in users get a personal,
      // auto-claimed agent; everyone else registers a fresh one.
      if (!cfg.agentToken) {
        if (cfg.userToken) {
          cfg = await ensurePersonalAgent(client, cfg);
        } else {
          const reg = await registerNewAgent(client, cfg, repoName);
          cfg = reg.cfg;
          unclaimed = { claimToken: reg.claimToken };
        }
      } else {
        console.log(chalk.gray(`• reusing agent "${cfg.agentName}"`));
      }

      const agentName = cfg.agentName;
      const agentToken = cfg.agentToken;
      if (!agentName || !agentToken) {
        console.error(chalk.red("✗ could not establish an agent session"));
        process.exit(1);
      }

      // (c) Make sure we're in a git repo.
      if (!isGitRepo()) {
        execSync("git init -b main", { stdio: "inherit" });
        console.log(chalk.green("✓ git init -b main"));
      }

      // (d) Point origin at the ClawHub repo, token embedded for push auth.
      const host = new URL(cfg.server).host;
      const remoteUrl = `https://agent-token:${agentToken}@${host}/${agentName}/${repoName}.git`;
      const hasOrigin = (() => {
        try { execSync("git remote get-url origin", { stdio: "ignore" }); return true; }
        catch { return false; }
      })();
      execSync(`git remote ${hasOrigin ? "set-url" : "add"} origin ${JSON.stringify(remoteUrl)}`, { stdio: "ignore" });
      console.log(chalk.green(`✓ remote origin → ${host}/${agentName}/${repoName}.git`));
      console.log(chalk.yellow("  note: your agent token is embedded in .git/config — keep it out of shared clones."));

      // (e) Next steps. The dashboard lives at the bare host: strip a leading
      // `api.` from the API origin, preserving the original scheme for localhost.
      const apiUrl = new URL(cfg.server);
      const dashboard = `${apiUrl.protocol}//${apiUrl.host.replace(/^api\./, "")}`;
      console.log();
      console.log(chalk.bold("Next:"));
      console.log(chalk.cyan(`  git commit -m "feat: initial commit

Intent: stand up ${repoName}
Risk: low
Agent: ${agentName}"`));
      console.log(chalk.cyan("  git push -u origin main"));
      console.log(chalk.gray(`  then watch it land at ${dashboard}/${agentName}/${repoName}`));

      // Solo dead-end guard: an unclaimed agent has no human to approve, so any
      // medium+ risk Change will block at merge. Surface the two ways forward
      // before the user hits that wall — reusing the claim token already printed.
      if (unclaimed) {
        console.log();
        console.log(chalk.yellow.bold("⚠ this agent is NOT linked to a human account."));
        console.log(chalk.gray("  Medium+ risk changes (and all sensitive-path changes) need a human to approve before merge."));
        console.log(chalk.gray("  Without a human, those changes will dead-end. Link one of two ways:"));
        console.log(chalk.gray("    1) ") + chalk.cyan("ch login") + chalk.gray(" then re-run ") + chalk.cyan("ch init") + chalk.gray(" — auto-claims this agent to your account."));
        if (unclaimed.claimToken) {
          console.log(chalk.gray("    2) sign up at ") + dashboard + chalk.gray(", then ") + chalk.cyan(`ch agents claim ${unclaimed.claimToken}`) + chalk.gray(" (the claim token above)."));
        } else {
          console.log(chalk.gray("    2) sign up at ") + dashboard + chalk.gray(", then ") + chalk.cyan("ch agents claim <token>") + chalk.gray(" with the claim token above."));
        }
      }
    });
}
