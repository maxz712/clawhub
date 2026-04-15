import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { ApiClient } from "../lib/api.js";

function parseRepo(): { ns: string; repo: string } {
  const remote = execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim();
  const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) { console.error(chalk.red("cannot parse remote")); process.exit(1); }
  return { ns: m[1], repo: m[2] };
}

async function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => data += c);
    process.stdin.on("end", () => resolve(data.replace(/\n$/, "")));
  });
}

export function registerSecretCommands(program: Command) {
  const g = program.command("secret").description("Repo secrets");

  g.command("list")
    .description("List secret names")
    .action(async () => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const { secrets } = await client.request<{ secrets: Array<{ name: string; createdAt: string }> }>("GET", `/api/v1/repos/${ns}/${repo}/secrets`);
      for (const s of secrets) console.log(`${chalk.cyan(s.name)} ${chalk.gray(s.createdAt)}`);
    });

  g.command("set <name>")
    .description("Set a secret (value read from stdin)")
    .action(async name => {
      const value = await readStdin();
      if (!value) { console.error(chalk.red("no value on stdin")); process.exit(1); }
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      await client.request("PUT", `/api/v1/repos/${ns}/${repo}/secrets/${name}`, { body: { value } });
      console.log(chalk.green(`✓ secret "${name}" set`));
    });

  g.command("unset <name>")
    .description("Delete a secret")
    .action(async name => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      await client.request("DELETE", `/api/v1/repos/${ns}/${repo}/secrets/${name}`);
      console.log(chalk.green(`✓ secret "${name}" removed`));
    });
}
