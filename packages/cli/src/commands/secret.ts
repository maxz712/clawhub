import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { parseRepo } from "../lib/repo.js";

async function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => data += c);
    process.stdin.on("end", () => resolve(data.replace(/\n$/, "")));
  });
}

async function deleteSecret(name: string) {
  const { ns, repo } = parseRepo();
  const client = new ApiClient();
  await client.request("DELETE", `/api/v1/repos/${ns}/${repo}/secrets/${name}`);
  console.log(chalk.green(`✓ secret "${name}" removed`));
}

export function registerSecretCommands(program: Command) {
  const g = program.command("secret").description("Repo secrets");

  g.command("list")
    .description("List secret names")
    .action(async () => {
      const { ns, repo } = parseRepo();
      const client = new ApiClient();
      const { secrets } = await client.request<{ secrets: Array<{ name: string; createdAt: string }> }>("GET", `/api/v1/repos/${ns}/${repo}/secrets`);
      if (!secrets.length) { console.log(chalk.gray("(no secrets)")); return; }
      for (const s of secrets) console.log(`${chalk.cyan(s.name)} ${chalk.gray(s.createdAt)}`);
    });

  g.command("set <name>")
    .description("Set a secret (value read from stdin)")
    .action(async name => {
      // The value is read from stdin; if stdin is a TTY there's nothing to read
      // and the process would hang waiting for EOF. Tell the operator how to
      // pipe it instead of stalling.
      if (process.stdin.isTTY) {
        console.error(chalk.red("✗ secret value must be piped in on stdin (it never lands in argv/shell history)."));
        console.error(chalk.gray("  e.g. ") + chalk.cyan(`echo -n VALUE | ch secret set ${name}`));
        process.exit(1);
      }
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
      await deleteSecret(name);
    });

  g.command("rm <name>")
    .description("Delete a secret")
    .action(async name => {
      await deleteSecret(name);
    });
}
