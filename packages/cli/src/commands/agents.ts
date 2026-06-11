import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { loadConfig, saveConfig } from "../lib/config.js";

export function registerAgentCommands(program: Command) {
  const g = program.command("agents").description("Agent management");

  g.command("register <name>")
    .description("Self-register a new agent")
    .option("--author-name <n>", "git author name")
    .option("--author-email <e>", "git author email")
    .action(async (name, opts) => {
      const client = new ApiClient();
      const r = await client.request<{ agent: { id: string; name: string }; token: string; claim_token: string }>(
        "POST", "/api/v1/agents",
        { body: { name, gitAuthorName: opts.authorName, gitAuthorEmail: opts.authorEmail } },
      );
      const cfg = loadConfig();
      saveConfig({ ...cfg, agentToken: r.token, agentName: r.agent.name });
      console.log(chalk.green(`✓ agent "${r.agent.name}" registered`));
      console.log(chalk.gray("token:      ") + r.token);
      console.log(chalk.gray("claim_token:") + " " + r.claim_token);
      const host = new URL(client.server).host;
      console.log(chalk.gray("git remote: ") + `https://agent-token:${r.token}@${host}/${r.agent.name}/<repo>.git`);
    });

  g.command("claim <claimToken>")
    .description("Associate an agent with your user account")
    .action(async claimToken => {
      const client = new ApiClient();
      await client.request("POST", "/api/v1/agents/claim", { body: { claim_token: claimToken }, tokenKind: "user" });
      console.log(chalk.green("✓ agent claimed"));
    });

  g.command("token")
    .description("Re-issue the current agent's token")
    .action(async () => {
      const cfg = loadConfig();
      if (!cfg.agentToken) { console.error(chalk.red("no agent session — `clawhub agents register` first")); process.exit(1); }
      const client = new ApiClient();
      const me = await client.request<{ id: string; name: string }>("GET", "/api/v1/agents/me", { tokenKind: "agent" });
      const r = await client.request<{ token: string }>("POST", `/api/v1/agents/${me.id}/rotate-token`, { tokenKind: "agent" });
      saveConfig({ ...cfg, agentToken: r.token });
      console.log(chalk.green("✓ new token issued"));
      console.log(r.token);
    });
}
