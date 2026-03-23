import { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../lib/api-client.js";
import { execGit, getRemoteUrl } from "../lib/git.js";

interface ChangeRecord {
  id: string;
  title?: string;
  status?: string;
  branch?: string;
  intent?: string;
  risk?: string;
  authorId?: string;
  agentId?: string;
  reviewerName?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface DecisionView {
  change: ChangeRecord;
  focusAreas?: Array<{ file?: string; lines?: string; reason?: string }>;
  reviewComments?: Array<{
    file?: string;
    line?: number;
    body?: string;
    author?: string;
  }>;
  reviews?: Array<{
    verdict?: string;
    body?: string;
    userId?: string;
    createdAt?: string;
  }>;
  [key: string]: unknown;
}

interface DiffView {
  focusAreas?: Array<{ file?: string; lines?: string; reason?: string }>;
  reviewComments?: Array<{
    file?: string;
    line?: number;
    body?: string;
    author?: string;
  }>;
  diff?: string;
  [key: string]: unknown;
}

/**
 * Parse owner/repo from the git remote URL.
 * Accepts formats like:
 *   http://localhost:3000/alice/myrepo.git
 *   https://clawforge.dev/alice/myrepo.git
 */
function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } {
  const cleaned = remoteUrl.replace(/\.git\s*$/, "");
  const parts = cleaned.split("/");
  if (parts.length < 2) {
    throw new Error(
      `Cannot determine owner/repo from remote URL: ${remoteUrl}`,
    );
  }
  const repo = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  return { owner, repo };
}

async function resolveOwnerRepo(): Promise<{ owner: string; repo: string }> {
  try {
    const url = await getRemoteUrl("origin");
    return parseOwnerRepo(url);
  } catch {
    console.error(
      chalk.red(
        "Could not determine owner/repo. Run from inside a cloned ClawForge repo.",
      ),
    );
    process.exit(1);
  }
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "--";
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
    case "pending":
      return chalk.cyan(status);
    case "approved":
      return chalk.green(status);
    case "rejected":
      return chalk.red(status);
    case "merged":
      return chalk.magenta(status);
    case "rolled_back":
      return chalk.dim(status);
    default:
      return status;
  }
}

export function registerChangeCommands(program: Command): void {
  const change = program
    .command("change")
    .description("Manage changes (the ClawForge equivalent of pull requests)");

  // ── list ──────────────────────────────────────────────────────────

  change
    .command("list")
    .description("List changes with intent, risk, status, and reviewer")
    .action(async () => {
      try {
        const { owner, repo } = await resolveOwnerRepo();
        const client = createClient();
        const result = (await client.listChanges(owner, repo)) as
          | ChangeRecord[]
          | { changes: ChangeRecord[] };

        const changes: ChangeRecord[] = Array.isArray(result)
          ? result
          : ((result as { changes: ChangeRecord[] }).changes ?? []);

        if (changes.length === 0) {
          console.log(chalk.dim("No changes found."));
          return;
        }

        console.log(chalk.bold("\n  Changes\n"));
        console.log(
          "  " +
            chalk.dim("ID".padEnd(10)) +
            chalk.dim("Status".padEnd(12)) +
            chalk.dim("Risk".padEnd(10)) +
            chalk.dim("Intent".padEnd(30)) +
            chalk.dim("Reviewer".padEnd(16)) +
            chalk.dim("Created"),
        );
        console.log(chalk.dim("  " + "-".repeat(95)));

        for (const c of changes) {
          const intent = c.intent ?? "--";
          const truncIntent =
            intent.length > 27 ? intent.slice(0, 27) + "..." : intent;
          const reviewer = (c.reviewerName as string) ?? "--";

          console.log(
            `  ${(c.id ?? "").toString().slice(0, 8).padEnd(10)}` +
              `${statusColor(c.status).padEnd(12 + 10)}` +
              `${riskColor(c.risk).padEnd(10 + 10)}` +
              `${truncIntent.padEnd(30)}` +
              `${reviewer.padEnd(16)}` +
              `${formatDate(c.createdAt)}`,
          );
        }
        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to list changes: ${message}`));
        process.exit(1);
      }
    });

  // ── show <id> (decision view) ─────────────────────────────────────

  change
    .command("show <id>")
    .description("Decision view for a change")
    .action(async (id: string) => {
      try {
        const { owner, repo } = await resolveOwnerRepo();
        const client = createClient();

        let view: DecisionView;
        try {
          view = (await client.getChangeDecisions(
            owner,
            repo,
            id,
          )) as DecisionView;
        } catch {
          // Fall back to basic change detail
          const c = (await client.getChange(owner, repo, id)) as ChangeRecord;
          view = { change: c };
        }

        const c = view.change;
        console.log(chalk.bold(`\n  Change ${c.id}\n`));
        console.log(`  ${chalk.dim("Status:")}    ${statusColor(c.status)}`);
        console.log(`  ${chalk.dim("Branch:")}    ${c.branch ?? "--"}`);
        console.log(`  ${chalk.dim("Risk:")}      ${riskColor(c.risk)}`);
        console.log(`  ${chalk.dim("Intent:")}    ${c.intent ?? "--"}`);
        console.log(
          `  ${chalk.dim("Author:")}    ${c.authorId ?? c.agentId ?? "--"}`,
        );
        console.log(`  ${chalk.dim("Created:")}   ${formatDate(c.createdAt)}`);
        console.log(`  ${chalk.dim("Updated:")}   ${formatDate(c.updatedAt)}`);

        if (view.focusAreas && view.focusAreas.length > 0) {
          console.log(chalk.bold("\n  Focus Areas\n"));
          for (const area of view.focusAreas) {
            console.log(
              `  ${chalk.cyan(area.file ?? "unknown")}${area.lines ? chalk.dim(`:${area.lines}`) : ""}`,
            );
            if (area.reason) {
              console.log(`    ${chalk.dim(area.reason)}`);
            }
          }
        }

        if (view.reviewComments && view.reviewComments.length > 0) {
          console.log(chalk.bold("\n  Review Comments\n"));
          for (const comment of view.reviewComments) {
            const location = comment.file
              ? `${chalk.cyan(comment.file)}${comment.line ? `:${comment.line}` : ""}`
              : "general";
            const author = comment.author
              ? chalk.magenta(comment.author)
              : "reviewer";
            console.log(`  ${location} -- ${author}`);
            if (comment.body) {
              console.log(`    ${comment.body}`);
            }
          }
        }

        if (view.reviews && view.reviews.length > 0) {
          console.log(chalk.bold("\n  Reviews\n"));
          for (const r of view.reviews) {
            const verdict =
              r.verdict === "approve"
                ? chalk.green("APPROVE")
                : r.verdict === "request_changes"
                  ? chalk.red("REQUEST CHANGES")
                  : chalk.dim(r.verdict ?? "comment");
            console.log(
              `  ${verdict}  ${chalk.dim(r.userId ?? "unknown")}  ${chalk.dim(formatDate(r.createdAt))}`,
            );
            if (r.body) {
              console.log(`    ${r.body}`);
            }
          }
        }

        console.log();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to show change: ${message}`));
        process.exit(1);
      }
    });

  // ── checkout <id> ─────────────────────────────────────────────────

  change
    .command("checkout <id>")
    .description("Fetch and checkout a change ref")
    .action(async (id: string) => {
      try {
        console.log(chalk.dim(`Fetching change ${id} refs...`));

        await execGit(
          "fetch",
          "origin",
          `refs/changes/${id}/head:refs/remotes/origin/changes/${id}/head`,
        );

        try {
          await execGit(
            "fetch",
            "origin",
            `refs/changes/${id}/merge:refs/remotes/origin/changes/${id}/merge`,
          );
        } catch {
          // merge ref may not exist yet
        }

        await execGit(
          "checkout",
          "-B",
          `change/${id}`,
          `refs/remotes/origin/changes/${id}/head`,
        );

        console.log(
          chalk.green(
            `Checked out change ${chalk.bold(id)} on branch ${chalk.cyan(`change/${id}`)}`,
          ),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Checkout failed: ${message}`));
        process.exit(1);
      }
    });

  // ── diff <id> ─────────────────────────────────────────────────────

  change
    .command("diff <id>")
    .description(
      "Decision-focused diff (default) or full diff with --full",
    )
    .option("--full", "Show full diff instead of decision-focused view")
    .option("--base <branch>", "Base branch to diff against", "main")
    .action(async (id: string, opts: { full?: boolean; base: string }) => {
      try {
        const { owner, repo } = await resolveOwnerRepo();
        const client = createClient();

        if (!opts.full) {
          // Decision-focused view via API
          try {
            const result = (await client.getChangeDiff(
              owner,
              repo,
              id,
              false,
            )) as DiffView;

            if (result.focusAreas && result.focusAreas.length > 0) {
              console.log(chalk.bold("\n  Focus Areas\n"));
              for (const area of result.focusAreas) {
                console.log(
                  `  ${chalk.cyan(area.file ?? "unknown")}${area.lines ? chalk.dim(`:${area.lines}`) : ""}`,
                );
                if (area.reason) {
                  console.log(`    ${chalk.dim(area.reason)}`);
                }
              }
            }

            if (result.reviewComments && result.reviewComments.length > 0) {
              console.log(chalk.bold("\n  Review Comments\n"));
              for (const comment of result.reviewComments) {
                const location = comment.file
                  ? `${chalk.cyan(comment.file)}${comment.line ? `:${comment.line}` : ""}`
                  : "general";
                const author = comment.author
                  ? chalk.magenta(comment.author)
                  : "reviewer";
                console.log(`  ${location} -- ${author}`);
                if (comment.body) {
                  console.log(`    ${comment.body}`);
                }
              }
            }

            if (result.diff) {
              console.log(chalk.bold("\n  Key Diff\n"));
              console.log(result.diff);
            }

            if (
              !result.focusAreas?.length &&
              !result.reviewComments?.length &&
              !result.diff
            ) {
              console.log(chalk.dim("No decision-focused data available."));
              console.log(chalk.dim("Use --full to see the complete diff."));
            }

            console.log();
            return;
          } catch {
            console.log(
              chalk.dim(
                "Decision-focused diff not available, falling back to full diff.\n",
              ),
            );
          }
        }

        // Full diff via git
        await execGit(
          "fetch",
          "origin",
          `refs/changes/${id}/head:refs/remotes/origin/changes/${id}/head`,
        );

        const diff = await execGit(
          "diff",
          `origin/${opts.base}...refs/remotes/origin/changes/${id}/head`,
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

  // ── merge <id> ────────────────────────────────────────────────────

  change
    .command("merge <id>")
    .description("Merge an approved change via the API")
    .action(async (id: string) => {
      try {
        const { owner, repo } = await resolveOwnerRepo();
        const client = createClient();

        await client.mergeChange(owner, repo, id);
        console.log(
          chalk.green(`Change ${chalk.bold(id)} merged successfully.`),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Merge failed: ${message}`));
        process.exit(1);
      }
    });
}
