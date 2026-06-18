import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { parseRepo } from "../lib/repo.js";

interface Release {
  id: string;
  tag: string;
  title: string;
  changeId: string | null;
  createdAt: string;
}

export function registerReleaseCommands(program: Command) {
  const g = program.command("release").description("Repo releases");

  g.command("list [ns/repo]")
    .description("List releases (newest first)")
    .action(async (repoArg?: string) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const { releases } = await client.request<{ releases: Release[] }>("GET", `/api/v1/repos/${ns}/${repo}/releases`);
      if (!releases.length) {
        console.log(chalk.gray("(no releases)"));
        console.log(chalk.gray("  cut one: ") + chalk.cyan('ch release create v1.0.0 --name "First release"') + chalk.gray("."));
        return;
      }
      for (const r of releases) {
        console.log(`${chalk.cyan(r.tag)}  ${r.title}  ${chalk.gray(r.createdAt)}`);
      }
    });

  g.command("create <tag> [ns/repo]")
    .description("Create a release at <tag> (optionally tied to a merged change with --change)")
    .option("-n, --name <name>", "release title (defaults to the tag)")
    .option("-c, --change <id>", "merged change to anchor the release to (optional)")
    .action(async (tag: string, repoArg: string | undefined, opts: { name?: string; change?: string }) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const body: Record<string, unknown> = { tag, title: opts.name ?? tag };
      if (opts.change) body.changeId = opts.change;
      const { release } = await client.request<{ release: Release }>("POST", `/api/v1/repos/${ns}/${repo}/releases`, { body });
      console.log(chalk.green(`✓ release ${release.tag} created`));
      if (release.title && release.title !== release.tag) console.log(chalk.gray("  title: ") + release.title);
    });
}
