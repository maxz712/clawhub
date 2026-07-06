import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiClient, ApiError } from "../lib/api.js";
import { loadConfig, saveConfig, type CliConfig } from "../lib/config.js";

const AGENTS_BEGIN = "<!-- clawhub:begin -->";
const AGENTS_END = "<!-- clawhub:end -->";

// Write the canonical ClawHub section into AGENTS.md between the markers,
// idempotently — replace an existing block, else append one. Foreign agents read
// AGENTS.md, so this is how a drive-by agent learns the trailer convention
// without ever reading our skill (M2 distribution). Best-effort + non-fatal.
async function ensureAgentsMd(server: string): Promise<void> {
  let block: string;
  try {
    const res = await fetch(`${server.replace(/\/+$/, "")}/api/v1/public/agents-md`);
    if (!res.ok) return;
    block = (await res.text()).trim();
  } catch { return; }
  if (!block.includes(AGENTS_BEGIN)) return; // server returned something unexpected
  const file = path.join(process.cwd(), "AGENTS.md");
  let next: string;
  let verb: "created" | "updated";
  if (existsSync(file)) {
    const cur = readFileSync(file, "utf8");
    const begin = cur.indexOf(AGENTS_BEGIN);
    const end = cur.indexOf(AGENTS_END);
    if (begin !== -1 && end !== -1 && end > begin) {
      const before = cur.slice(0, begin);
      const after = cur.slice(end + AGENTS_END.length);
      const merged = `${before}${block}${after}`;
      if (merged === cur) return; // already current — no write, no noise
      next = merged; verb = "updated";
    } else {
      next = `${cur.replace(/\s*$/, "")}\n\n${block}\n`; verb = "updated";
    }
  } else {
    next = `# Agent instructions\n\n${block}\n`; verb = "created";
  }
  writeFileSync(file, next);
  console.log(chalk.green(`✓ AGENTS.md ${verb}`) + chalk.gray(" (ClawHub trailer guidance for foreign agents)"));
}

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

// Make sure the logged-in user's handle is known locally — it's both the git
// remote path namespace and the Basic-auth username for a human push. Fetches
// /me (which mints one on demand) when the cached config predates handles.
async function ensureUserHandle(client: ApiClient, cfg: CliConfig): Promise<{ cfg: CliConfig; handle: string }> {
  if (cfg.userHandle) return { cfg, handle: cfg.userHandle };
  const me = await client.request<{ email: string; username?: string }>("GET", "/api/v1/users/me", { tokenKind: "user" });
  if (!me.username) throw new Error("could not resolve your ClawHub handle");
  const next = { ...cfg, userHandle: me.username };
  saveConfig(next);
  return { cfg: next, handle: me.username };
}

// Find-or-create a personal agent for a logged-in user, auto-claimed to their
// account. Used only with `ch init --agent` now that humans push as themselves
// by default — for the user who wants an agent identity pushing on their behalf.
async function ensurePersonalAgent(client: ApiClient, cfg: CliConfig): Promise<CliConfig> {
  const r = await client.request<{ agent: { id: string; name: string }; owner?: string; token?: string; created: boolean }>(
    "POST", "/api/v1/agents/personal", { tokenKind: "user", body: { rotate: true } },
  );
  if (!r.token) throw new Error("server did not return an agent token");
  const next = { ...cfg, agentToken: r.token, agentName: r.agent.name, ownerHandle: r.owner ?? cfg.ownerHandle };
  saveConfig(next);
  const verb = r.created ? "created" : "token refreshed";
  console.log(chalk.green(`✓ personal agent "${r.agent.name}" ${verb} (auto-claimed to your account)`));
  if (r.owner) console.log(chalk.gray(`  you own repos under @${r.owner}; this agent is granted push.`));
  if (!r.created) console.log(chalk.gray("  note: this refreshed the token — other machines using this agent will need to re-init."));
  return next;
}

// Register a brand-new agent for an unauthenticated caller (self-host only —
// the hosted product requires a user Bearer; v3 removed the claim-token flow).
async function registerNewAgent(client: ApiClient, cfg: CliConfig, repoName: string): Promise<{ cfg: CliConfig; claimToken?: string }> {
  const name = `${repoName}-agent`;
  // throwOnError so a name conflict (409) reaches our recovery hint below
  // instead of api.ts exiting the process before we can guide the user.
  let r: { agent: { id: string; name: string }; owner?: string; token: string; claimed?: boolean };
  try {
    r = await client.request("POST", "/api/v1/agents", { body: { name }, throwOnError: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      console.error(chalk.red(`✗ agent name "${name}" is already taken`));
      console.error(chalk.gray("  Pick a unique name one of two ways:"));
      console.error(chalk.gray("    • run ") + chalk.cyan("ch init <repo-name>") + chalk.gray(" with a different name, or"));
      console.error(chalk.gray("    • register one explicitly: ") + chalk.cyan("ch agents register <name>"));
      console.error(chalk.gray("  Just want to push your own code? ") + chalk.cyan("ch login") + chalk.gray(" then re-run ") + chalk.cyan("ch init") + chalk.gray(" — you'll push as yourself, no agent needed."));
      process.exit(1);
    }
    throw err;
  }
  const next = { ...cfg, agentToken: r.token, agentName: r.agent.name, ownerHandle: r.owner ?? r.agent.name };
  saveConfig(next);
  console.log(chalk.green(`✓ agent "${r.agent.name}" registered`));
  console.log(chalk.gray("  agent name taken? re-run with a directory whose basename is unique, or ") + chalk.cyan("ch agents register <name>") + chalk.gray("."));
  return { cfg: next };
}

// Point origin at the ClawHub repo with credentials embedded for push auth.
// `scheme` follows the configured server (https in prod; http for a local/self-
// hosted dev server) so the remote actually connects.
function setRemote(scheme: string, host: string, username: string, token: string, owner: string, repoName: string): void {
  const remoteUrl = `${scheme}//${encodeURIComponent(username)}:${token}@${host}/${owner}/${repoName}.git`;
  const hasOrigin = (() => {
    try { execSync("git remote get-url origin", { stdio: "ignore" }); return true; }
    catch { return false; }
  })();
  execSync(`git remote ${hasOrigin ? "set-url" : "add"} origin ${JSON.stringify(remoteUrl)}`, { stdio: "ignore" });
  console.log(chalk.green(`✓ remote origin → ${host}/${owner}/${repoName}.git`));
  console.log(chalk.yellow("  note: your access token is embedded in .git/config — keep it out of shared clones."));
}

export function registerInitCommand(program: Command) {
  program.command("init [repo-name]")
    .description("Bootstrap the current directory: connect it to ClawHub and set a push remote")
    .option("--agent", "push via a personal agent instead of as yourself (sets up an auto-claimed agent identity)")
    .action(async (repoArg: string | undefined, opts: { agent?: boolean }) => {
      let cfg = loadConfig();
      const client = new ApiClient(cfg);
      const repoName = defaultRepoName(repoArg);
      const apiUrl = new URL(cfg.server);
      const host = apiUrl.host;
      const scheme = apiUrl.protocol; // "https:" in prod, "http:" for local/self-hosted dev
      // The dashboard lives at the bare host: strip a leading `api.` from the API
      // origin, preserving the original scheme for localhost.
      const dashboard = `${apiUrl.protocol}//${apiUrl.host.replace(/^api\./, "")}`;

      // Make sure we're in a git repo before wiring a remote.
      const ensureGitRepo = () => {
        if (!isGitRepo()) {
          execSync("git init -b main", { stdio: "inherit" });
          console.log(chalk.green("✓ git init -b main"));
        }
      };

      // ── Human push (default for a logged-in user) ──────────────────────────
      // Humans are first-class pushers: a logged-in person commits their own
      // code with their user token. No agent, no claim token, no dead-ends.
      if (cfg.userToken && !opts.agent) {
        const userToken = cfg.userToken;
        let handle: string;
        try {
          const r = await ensureUserHandle(client, cfg);
          cfg = r.cfg; handle = r.handle;
        } catch (err) {
          console.error(chalk.red(`✗ ${(err as Error).message}`));
          console.error(chalk.gray("  Try ") + chalk.cyan("ch login") + chalk.gray(" again, or push via an agent: ") + chalk.cyan("ch init --agent") + chalk.gray("."));
          process.exit(1);
        }
        ensureGitRepo();
        setRemote(scheme, host, handle, userToken, handle, repoName);
        await ensureAgentsMd(cfg.server);
        console.log();
        console.log(chalk.bold("Next:"));
        console.log(chalk.cyan(`  git add -A && git commit -m "feat: initial commit"`));
        console.log(chalk.cyan("  git push -u origin main"));
        console.log(chalk.gray(`  then watch it land at ${dashboard}/${handle}/${repoName}`));
        console.log(chalk.gray("  you're pushing as ") + chalk.cyan(`@${handle}`) + chalk.gray(" — your commits, your name. Want an agent to push instead? ") + chalk.cyan("ch init --agent") + chalk.gray("."));
        return;
      }

      // ── Agent push ─────────────────────────────────────────────────────────
      // Either explicitly requested (--agent), or the caller isn't a logged-in
      // human (a headless agent bootstrapping itself). Reuse an existing agent
      // token, mint a personal one for a logged-in user, or register a fresh one.
      let unclaimed: { claimToken?: string } | null = null;
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
      const owner = cfg.ownerHandle ?? agentName;

      ensureGitRepo();
      // The git Basic-auth username for an agent push is the literal `agent-token`.
      setRemote(scheme, host, "agent-token", agentToken, owner, repoName);
      await ensureAgentsMd(cfg.server);

      console.log();
      console.log(chalk.bold("Next:"));
      console.log(chalk.cyan(`  git commit -m "feat: initial commit

Intent: stand up ${repoName}
Risk: low
Agent: ${agentName}"`));
      console.log(chalk.cyan("  git push -u origin main"));
      console.log(chalk.gray(`  then watch it land at ${dashboard}/${owner}/${repoName}`));

      // Solo dead-end guard: an unclaimed agent has no human to approve, so any
      // medium+ risk Change will block at merge. Surface the two ways forward
      // before the user hits that wall — reusing the claim token already printed.
      if (unclaimed) {
        console.log();
        console.log(chalk.yellow.bold("⚠ this agent is NOT linked to a human account."));
        console.log(chalk.gray("  Medium+ risk changes (and all sensitive-path changes) need a human to approve before merge."));
        console.log(chalk.gray("  Without a human, those changes will dead-end. Two ways forward:"));
        console.log(chalk.gray("    1) ") + chalk.cyan("ch login") + chalk.gray(" then re-run ") + chalk.cyan("ch init") + chalk.gray(" — push your own code as yourself (simplest), or add ") + chalk.cyan("--agent") + chalk.gray(" to claim this agent."));
        if (unclaimed.claimToken) {
          console.log(chalk.gray("    2) sign up at ") + dashboard + chalk.gray(", then ") + chalk.cyan(`ch agents claim ${unclaimed.claimToken}`) + chalk.gray(" (the claim token above)."));
        } else {
          console.log(chalk.gray("    2) sign up at ") + dashboard + chalk.gray(", then ") + chalk.cyan("ch agents claim <token>") + chalk.gray(" with the claim token above."));
        }
      }
    });
}
