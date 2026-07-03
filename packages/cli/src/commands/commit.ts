import type { Command } from "commander";
import chalk from "chalk";
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { loadConfig } from "../lib/config.js";
import { appendMissingTrailers, composeCommitMessage, hasTrailers, mergeTrailers, parseTrailerValues, stripTrailerBlock, RISKS, type Risk, type TrailerInput } from "../lib/trailers.js";

function git(args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { encoding: "utf8", input });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOut(args: string[]): string {
  try { return execFileSync("git", args, { encoding: "utf8" }); } catch { return ""; }
}

function ensureRisk(v: string | undefined): Risk | undefined {
  if (!v) return undefined;
  const r = v.toLowerCase();
  if ((RISKS as string[]).includes(r)) return r as Risk;
  console.error(chalk.red(`✗ --risk must be one of ${RISKS.join("|")}`));
  process.exit(1);
}

function csv(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return v.split(",").map(s => s.trim()).filter(Boolean);
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>(resolve => rl.question(question, answer => resolve(answer.trim())));
  } finally {
    rl.close();
  }
}

export function registerCommitCommands(program: Command) {
  program.command("commit")
    .description("Commit staged changes with an auto-composed ClawHub trailer block")
    .option("-m, --message <subject>", "commit subject line")
    .option("--intent <text>", "Intent: trailer (what this change does)")
    .option("--risk <level>", `Risk: trailer (${RISKS.join("|")}, default low — it's only a floor)`)
    .option("--scope <csv>", "Scope: trailer (default: derived from staged files)")
    .option("--focus <line...>", "Review-Focus: line(s), e.g. src/x.ts:10-20 — reason")
    .option("--closes <n...>", "Closes: issue number(s)")
    .option("--agent <name>", "Agent: trailer (default: your configured agent)")
    .option("-a, --all", "stage all tracked, modified files first (like git commit -a)")
    .option("--amend", "amend the previous commit instead of creating a new one")
    .action(async (opts: {
      message?: string; intent?: string; risk?: string; scope?: string;
      focus?: string[]; closes?: string[]; agent?: string; all?: boolean; amend?: boolean;
    }) => {
      const cfg = loadConfig();
      if (git(["rev-parse", "--is-inside-work-tree"]).code !== 0) {
        console.error(chalk.red("✗ not a git repository")); process.exit(1);
      }
      if (opts.all) git(["add", "-A", "-u"]);

      // Subject: -m, or (for --amend) reuse the existing subject.
      let subject = opts.message?.trim();
      const existing = opts.amend ? gitOut(["log", "-1", "--pretty=%B"]) : "";
      if (!subject && opts.amend) subject = gitOut(["log", "-1", "--pretty=%s"]).trim();
      if (!subject) {
        if (process.stdin.isTTY) subject = (await promptLine("Commit subject: ")).trim();
        if (!subject) { console.error(chalk.red("✗ a commit subject is required (-m)")); process.exit(1); }
      }

      // Scope: explicit, else derived from the staged file list.
      let scope = csv(opts.scope);
      if (!scope) {
        const staged = gitOut(["diff", "--cached", "--name-only"]).split("\n").map(s => s.trim()).filter(Boolean);
        scope = staged.length ? staged : undefined;
      }
      if (!scope || scope.length === 0) {
        // Nothing staged and no scope — refuse rather than compose an empty commit.
        if (!opts.amend) { console.error(chalk.red("✗ nothing staged to commit (use -a to stage tracked changes)")); process.exit(1); }
      }

      // Trailers from the CLI flags only (unset stays undefined so an --amend
      // merge can carry forward the existing values the user didn't override).
      const flagTrailers: TrailerInput = {
        intent: opts.intent,
        risk: ensureRisk(opts.risk),
        scope,
        reviewFocus: opts.focus,
        closes: (opts.closes ?? []).map(n => Number(n.replace(/^#/, ""))).filter(n => Number.isFinite(n)),
        agent: opts.agent ?? cfg.agentName,
      };

      // On --amend, MERGE flags over the existing trailers (so --focus adds a
      // Review-Focus without wiping the risk you set earlier), preserving the
      // prose body. Fresh commits compose from the flags, defaulting sensibly.
      let message: string;
      if (opts.amend && hasTrailers(existing)) {
        const merged = mergeTrailers(parseTrailerValues(existing), flagTrailers);
        merged.intent = merged.intent ?? subject;
        merged.risk = merged.risk ?? "low";
        message = composeCommitMessage(subject!, stripTrailerBlock(existing) || undefined, merged);
      } else {
        const t: TrailerInput = { ...flagTrailers, intent: flagTrailers.intent ?? subject, risk: flagTrailers.risk ?? "low" };
        const bodyLines = opts.amend ? stripTrailerBlock(existing) : "";
        message = composeCommitMessage(subject!, bodyLines || undefined, t);
      }

      const args = ["commit", "-F", "-"];
      if (opts.amend) args.push("--amend");
      const res = spawnSync("git", args, { input: message, stdio: ["pipe", "inherit", "inherit"] });
      if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
      const finalRisk = ensureRisk(opts.risk) ?? (opts.amend ? parseTrailerValues(existing).risk : undefined) ?? "low";
      console.log(chalk.green("✓ committed with trailers") + chalk.gray(` (risk: ${finalRisk}${scope?.length ? `, scope: ${scope.length} file${scope.length === 1 ? "" : "s"}` : ""})`));
    });

  program.command("push [remote] [branch]")
    .description("Amend the head commit with missing ClawHub trailers, then git push")
    .option("--intent <text>", "Intent: trailer (prompts if missing and interactive)")
    .option("--risk <level>", `Risk: trailer (${RISKS.join("|")}, default low)`)
    .option("--scope <csv>", "Scope: trailer (default: derived from the branch's changed files)")
    .option("--agent <name>", "Agent: trailer (default: your configured agent)")
    .option("--no-amend", "push without touching the commit message")
    .option("-u, --set-upstream", "pass -u to git push")
    .option("-f, --force", "pass --force to git push")
    .action(async (remote: string | undefined, branch: string | undefined, opts: {
      intent?: string; risk?: string; scope?: string; agent?: string; amend?: boolean;
      setUpstream?: boolean; force?: boolean;
    }) => {
      const cfg = loadConfig();
      if (git(["rev-parse", "--is-inside-work-tree"]).code !== 0) {
        console.error(chalk.red("✗ not a git repository")); process.exit(1);
      }

      if (opts.amend !== false) {
        const head = gitOut(["log", "-1", "--pretty=%B"]);
        const present = hasTrailers(head);
        let intent = opts.intent;
        if (!present && !intent && process.stdin.isTTY) {
          const subject = gitOut(["log", "-1", "--pretty=%s"]).trim();
          const ans = await promptLine(chalk.gray(`Intent for this change [${subject}]: `));
          intent = ans || subject;
        }
        // Scope from the branch range against its upstream, else the head commit's files.
        let scope = csv(opts.scope);
        if (!scope) {
          const upstream = gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim();
          const files = upstream
            ? gitOut(["diff", "--name-only", `${upstream}..HEAD`])
            : gitOut(["show", "--name-only", "--pretty=format:", "HEAD"]);
          const list = files.split("\n").map(s => s.trim()).filter(Boolean);
          scope = list.length ? [...new Set(list)] : undefined;
        }
        const t: TrailerInput = { intent, risk: ensureRisk(opts.risk) ?? "low", scope, agent: opts.agent ?? cfg.agentName };
        const next = appendMissingTrailers(head, t);
        if (next.trim() !== head.trim()) {
          const res = spawnSync("git", ["commit", "--amend", "-F", "-"], { input: next, stdio: ["pipe", "inherit", "inherit"] });
          if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
          console.log(chalk.green("✓ amended head commit with trailers"));
        }
      }

      // Forward to git push with the common flags.
      const pushArgs = ["push"];
      if (opts.setUpstream) pushArgs.push("-u");
      if (opts.force) pushArgs.push("--force");
      if (remote) pushArgs.push(remote);
      if (branch) pushArgs.push(branch);
      const res = spawnSync("git", pushArgs, { stdio: "inherit" });
      process.exit(res.status ?? 0);
    });
}
