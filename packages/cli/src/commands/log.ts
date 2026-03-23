import { Command } from "commander";
import chalk from "chalk";
import { execGit } from "../lib/git.js";

const TRAILER_KEYS = ["Intent", "Risk", "Scope", "Agent", "Review-Focus", "Refs"];

interface ParsedCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
  trailers: Record<string, string>;
}

function parseLogOutput(raw: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  const entries = raw.split("\x00").filter((e) => e.trim());

  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    if (lines.length < 3) continue;

    const hash = lines[0];
    const author = lines[1];
    const date = lines[2];
    const bodyLines = lines.slice(3);

    const trailers: Record<string, string> = {};
    const messageLines: string[] = [];

    for (const line of bodyLines) {
      const trailerMatch = line.match(/^([\w-]+):\s*(.+)$/);
      if (trailerMatch && TRAILER_KEYS.includes(trailerMatch[1])) {
        trailers[trailerMatch[1]] = trailerMatch[2].trim();
      } else {
        messageLines.push(line);
      }
    }

    commits.push({
      hash,
      author,
      date,
      message: messageLines.join("\n").trim(),
      trailers,
    });
  }

  return commits;
}

function riskColor(risk: string): string {
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

function formatCommit(commit: ParsedCommit): string {
  const lines: string[] = [];

  lines.push(chalk.yellow(commit.hash));
  lines.push(`Author: ${commit.author}`);
  lines.push(`Date:   ${commit.date}`);
  lines.push("");

  if (commit.message) {
    for (const line of commit.message.split("\n")) {
      lines.push(`    ${line}`);
    }
  }

  const trailerEntries = Object.entries(commit.trailers);
  if (trailerEntries.length > 0) {
    lines.push("");
    for (const [key, value] of trailerEntries) {
      let colored: string;
      switch (key) {
        case "Intent":
          colored = chalk.cyan(value);
          break;
        case "Risk":
          colored = riskColor(value);
          break;
        case "Scope":
          colored = chalk.dim(value);
          break;
        case "Agent":
          colored = chalk.magenta(value);
          break;
        case "Review-Focus":
          colored = chalk.blue(value);
          break;
        case "Refs":
          colored = chalk.dim(value);
          break;
        default:
          colored = value;
      }
      lines.push(`    ${chalk.bold(key)}: ${colored}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function registerLogCommands(program: Command): void {
  program
    .command("log")
    .description("Trailer-aware git log with highlighted ClawForge metadata")
    .option("--agent <name>", "Filter commits by Agent trailer")
    .option("-n, --count <number>", "Number of commits to show", "20")
    .action(async (opts: { agent?: string; count: string }) => {
      try {
        const count = parseInt(opts.count, 10) || 20;

        const raw = await execGit(
          "log",
          `-${count}`,
          "--format=%H%n%an <%ae>%n%ai%n%B%x00",
        );

        if (!raw) {
          console.log(chalk.dim("No commits found."));
          return;
        }

        const commits = parseLogOutput(raw);

        const filtered = opts.agent
          ? commits.filter(
              (c) =>
                c.trailers["Agent"] &&
                c.trailers["Agent"]
                  .toLowerCase()
                  .includes(opts.agent!.toLowerCase()),
            )
          : commits;

        if (filtered.length === 0) {
          if (opts.agent) {
            console.log(
              chalk.dim(`No commits found with Agent: ${opts.agent}`),
            );
          } else {
            console.log(chalk.dim("No commits found."));
          }
          return;
        }

        for (const commit of filtered) {
          console.log(formatCommit(commit));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Log failed: ${message}`));
        process.exit(1);
      }
    });
}
