import { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../lib/api-client.js";
import { execGit, getCurrentBranch } from "../lib/git.js";

interface ChangeRecord {
  id: string;
  title?: string;
  status?: string;
  branch?: string;
  intent?: string;
  risk?: string;
  authorId?: string;
  agentId?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface ReviewRecord {
  id: string;
  status?: string;
  body?: string;
  userId?: string;
  createdAt?: string;
  [key: string]: unknown;
}

function resolveRepoId(opts: { repo?: string }): string {
  if (opts.repo) return opts.repo;
  console.error(
    chalk.red("No repository specified. Use --repo <id> or run from inside a cloned repo.")
  );
  process.exit(1);
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

function riskColor(risk?: string): string {
  if (!risk) return chalk.dim("unknown");
  switch (risk.toLowerCase()) {
    case "low":
      return chalk.green(risk);
    case "medium":
      return chalk.yellow(risk);
    case "high":
      return chalk.red(risk);
    case "critical":
      return chalk.bgRed.white(risk);
    default:
      return risk;
  }
}

function statusColor(status?: string): string {
  if (!status) return chalk.dim("unknown");
  switch (status.toLowerCase()) {
    case "open":
      return chalk.cyan(status);
    case "approved":
      return chalk.green(status);
    case "rejected":
      return chalk.red(status);
    case "merged":
      return chalk.magenta(status);
    default:
      return status;
  }
}

export function registerChangeCommands(program: Command): void {
  const change = program
    .command("change")
    .description("Manage changes (the ClawForge equivalent of pull requests)")
    .option("--repo <id>", "Repository ID");

  change
    .command("list")
    .description("List changes for a repository")
    .action(async (_opts: unknown, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.opts() as { repo?: string } | undefined;
        const repoId = resolveRepoId(parentOpts ?? {});
        const client = createClient();
        const result = (await client.listChanges(repoId)) as ChangeRecord[] | { changes: ChangeRecord[] };

        const changes: ChangeRecord[] = Array.isArray(result)
          ? result
          : (result as { changes: ChangeRecord[] }).changes ?? [];

        if (changes.length === 0) {
          console.log(chalk.dim("No changes found."));
          return;
        }

        console.log(chalk.bold("\n  Changes\n"));
        console.log(
          chalk.dim("  ID".padEnd(40)) +
          chalk.dim("Status".padEnd(12)) +
          chalk.dim("Risk".padEnd(12)) +
          chalk.dim("Branch".padEnd(25)) +
          chalk.dim("Created")
        );
        console.log(chalk.dim("  " + "—".repeat(95)));

        for (const c of changes) {
          console.log(
            `  ${(c.id ?? "").toString().padEnd(38)}` +
            `${statusColor(c.status).padEnd(12 + 10)}` +
            `${riskColor(c.risk).padEnd(12 + 10)}` +
            `${(c.branch ?? "—").padEnd(25)}` +
            `${formatDate(c.createdAt)}`
          );
        }
        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to list changes: ${message}`));
        process.exit(1);
      }
    });

  change
    .command("show <id>")
    .description("Show details of a change")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.parent?.opts() as { repo?: string } | undefined;
        const repoId = resolveRepoId(parentOpts ?? {});
        const client = createClient();
        const c = (await client.getChange(repoId, id)) as ChangeRecord;

        console.log(chalk.bold(`\n  Change ${c.id}\n`));
        console.log(`  ${chalk.dim("Status:")}    ${statusColor(c.status)}`);
        console.log(`  ${chalk.dim("Branch:")}    ${c.branch ?? "—"}`);
        console.log(`  ${chalk.dim("Risk:")}      ${riskColor(c.risk)}`);
        console.log(`  ${chalk.dim("Intent:")}    ${c.intent ?? "—"}`);
        console.log(`  ${chalk.dim("Author:")}    ${c.authorId ?? c.agentId ?? "—"}`);
        console.log(`  ${chalk.dim("Created:")}   ${formatDate(c.createdAt)}`);
        console.log(`  ${chalk.dim("Updated:")}   ${formatDate(c.updatedAt)}`);
        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to show change: ${message}`));
        process.exit(1);
      }
    });

  change
    .command("checkout <id>")
    .description("Fetch and checkout a change branch")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.parent?.opts() as { repo?: string } | undefined;
        void parentOpts; // checkout works locally via git refs

        console.log(chalk.dim(`Fetching change ${id} refs...`));

        await execGit("fetch", "origin", `refs/changes/${id}/head:refs/remotes/origin/changes/${id}/head`);

        try {
          await execGit("fetch", "origin", `refs/changes/${id}/merge:refs/remotes/origin/changes/${id}/merge`);
        } catch {
          // merge ref may not exist yet
        }

        await execGit("checkout", "-B", `change/${id}`, `refs/remotes/origin/changes/${id}/head`);

        console.log(chalk.green(`Checked out change ${chalk.bold(id)} on branch ${chalk.cyan(`change/${id}`)}`));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Checkout failed: ${message}`));
        process.exit(1);
      }
    });

  change
    .command("diff <id>")
    .description("Show diff for a change against the default branch")
    .option("--base <branch>", "Base branch to diff against", "main")
    .option("--focused", "Show only focus areas and review comments")
    .option("--full", "Show full git diff (overrides --focused)")
    .action(async (id: string, opts: { base: string; focused?: boolean; full?: boolean }, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.parent?.opts() as { repo?: string } | undefined;

        // If --focused is requested (and not --full), try the focused diff API
        if (opts.focused && !opts.full) {
          const repoId = resolveRepoId(parentOpts ?? {});
          const client = createClient();

          try {
            const result = (await client.getFocusedDiff(repoId, id)) as {
              focusAreas?: Array<{ file?: string; lines?: string; reason?: string }>;
              reviewComments?: Array<{ file?: string; line?: number; body?: string; author?: string }>;
            };

            if (result.focusAreas && result.focusAreas.length > 0) {
              console.log(chalk.bold("\n  Focus Areas\n"));
              for (const area of result.focusAreas) {
                console.log(`  ${chalk.cyan(area.file ?? "unknown")}${area.lines ? chalk.dim(`:${area.lines}`) : ""}`);
                if (area.reason) {
                  console.log(`    ${chalk.dim(area.reason)}`);
                }
              }
            } else {
              console.log(chalk.dim("\n  No focus areas identified."));
            }

            if (result.reviewComments && result.reviewComments.length > 0) {
              console.log(chalk.bold("\n  Review Comments\n"));
              for (const comment of result.reviewComments) {
                const location = comment.file
                  ? `${chalk.cyan(comment.file)}${comment.line ? `:${comment.line}` : ""}`
                  : "general";
                const author = comment.author ? chalk.magenta(comment.author) : "reviewer";
                console.log(`  ${location} ${chalk.dim("—")} ${author}`);
                if (comment.body) {
                  console.log(`    ${comment.body}`);
                }
              }
            }

            console.log();
            return;
          } catch {
            // Focused diff not available, fall through to full diff
            console.log(chalk.dim("Focused diff not available, showing full diff.\n"));
          }
        }

        // Default: show full git diff
        // If neither --focused nor --full specified, try focused first if repo is available
        if (!opts.focused && !opts.full && parentOpts?.repo) {
          const client = createClient();
          try {
            const result = (await client.getFocusedDiff(parentOpts.repo, id)) as {
              focusAreas?: Array<{ file?: string; lines?: string; reason?: string }>;
            };
            if (result.focusAreas && result.focusAreas.length > 0) {
              console.log(chalk.bold("\n  Focus Areas\n"));
              for (const area of result.focusAreas) {
                console.log(`  ${chalk.cyan(area.file ?? "unknown")}${area.lines ? chalk.dim(`:${area.lines}`) : ""}`);
                if (area.reason) {
                  console.log(`    ${chalk.dim(area.reason)}`);
                }
              }
              console.log(chalk.dim("\n  Use --full to see the complete diff.\n"));
            }
          } catch {
            // Ignore - just show full diff
          }
        }

        // Make sure we have the change ref locally
        await execGit("fetch", "origin", `refs/changes/${id}/head:refs/remotes/origin/changes/${id}/head`);

        const diff = await execGit(
          "diff",
          `origin/${opts.base}...refs/remotes/origin/changes/${id}/head`
        );

        if (!diff) {
          console.log(chalk.dim("No differences found."));
        } else {
          console.log(diff);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Diff failed: ${message}`));
        process.exit(1);
      }
    });

  change
    .command("review <id>")
    .description("Submit a review for a change")
    .option("--approve", "Approve the change")
    .option("--reject <reason>", "Reject the change with a reason")
    .option("--comment <text>", "Add a comment")
    .action(async (id: string, opts: { approve?: boolean; reject?: string; comment?: string }, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.parent?.opts() as { repo?: string } | undefined;
        const repoId = resolveRepoId(parentOpts ?? {});
        const client = createClient();

        if (opts.approve) {
          await client.approveChange(repoId, id);
          console.log(chalk.green(`Change ${chalk.bold(id)} approved.`));
        } else if (opts.reject) {
          await client.rejectChange(repoId, id, opts.reject);
          console.log(chalk.red(`Change ${chalk.bold(id)} rejected.`));
          console.log(chalk.dim(`Reason: ${opts.reject}`));
        } else if (opts.comment) {
          await client.submitReview(repoId, id, { status: "comment", body: opts.comment });
          console.log(chalk.green("Comment submitted."));
        } else {
          console.error(chalk.red("Specify --approve, --reject <reason>, or --comment <text>"));
          process.exit(1);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Review failed: ${message}`));
        process.exit(1);
      }
    });

  change
    .command("merge <id>")
    .description("Merge an approved change")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.parent?.opts() as { repo?: string } | undefined;
        const repoId = resolveRepoId(parentOpts ?? {});
        const client = createClient();

        await client.mergeChange(repoId, id);
        console.log(chalk.green(`Change ${chalk.bold(id)} merged successfully.`));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Merge failed: ${message}`));
        process.exit(1);
      }
    });

  change
    .command("create")
    .description("Create a new change from the current branch")
    .requiredOption("--intent <text>", "Description of the intent behind this change")
    .option("--branch <name>", "Branch name (defaults to current branch)")
    .action(async (opts: { intent: string; branch?: string }, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.parent?.opts() as { repo?: string } | undefined;
        const repoId = resolveRepoId(parentOpts ?? {});
        const client = createClient();

        const branch = opts.branch ?? (await getCurrentBranch());

        console.log(chalk.dim(`Pushing branch ${chalk.cyan(branch)}...`));
        await execGit("push", "origin", branch);

        console.log(chalk.dim("Creating change..."));
        const result = (await client.createChange(repoId, {
          branch,
          intent: opts.intent,
        })) as ChangeRecord;

        console.log(chalk.green(`\nChange created successfully!`));
        console.log(`  ${chalk.dim("ID:")}     ${result.id}`);
        console.log(`  ${chalk.dim("Branch:")} ${branch}`);
        console.log(`  ${chalk.dim("Intent:")} ${opts.intent}`);
        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Create failed: ${message}`));
        process.exit(1);
      }
    });
}
