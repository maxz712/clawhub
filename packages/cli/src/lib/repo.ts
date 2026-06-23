import chalk from "chalk";
import { execSync } from "node:child_process";
import type { ApiClient } from "./api.js";

// Resolve the current directory's ClawHub repo from `remote.origin.url`.
// Accepts an explicit `ns/repo` argument; otherwise reads the git remote.
// Emits a guided error (instead of a raw Node exception) when run outside a
// git repo or when no origin remote is set.
export function parseRepo(arg?: string): { ns: string; repo: string } {
  if (arg) {
    const m = arg.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) { console.error(chalk.red(`✗ cannot parse "${arg}" — expected ns/repo`)); process.exit(1); }
    return { ns: m[1], repo: m[2] };
  }
  let remote: string;
  try {
    remote = execSync("git config --get remote.origin.url", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    console.error(chalk.red("✗ not inside a ClawHub git repo (no origin remote)."));
    console.error(chalk.gray("  Run ") + chalk.cyan("ch init") + chalk.gray(" to connect this directory to ClawHub, or pass ns/repo explicitly."));
    process.exit(1);
  }
  if (!remote) {
    console.error(chalk.red("✗ this git repo has no origin remote."));
    console.error(chalk.gray("  Run ") + chalk.cyan("ch init") + chalk.gray(" to connect this directory to ClawHub."));
    process.exit(1);
  }
  const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) { console.error(chalk.red(`✗ cannot parse remote origin URL: ${remote}`)); process.exit(1); }
  return { ns: m[1], repo: m[2] };
}

// CLI lists print an 8-char ID prefix, but most APIs match the full UUID
// exactly. Resolve a user-supplied prefix (or full ID) against a client-side
// list. A full UUID passes straight through; a single prefix match resolves;
// zero or ambiguous prints a guided error and exits. `kind` names the entity
// (e.g. "change", "standing agent") for the error copy.
export function resolveIdPrefix(items: Array<{ id: string }>, idOrPrefix: string, kind: string): string {
  // Full UUIDs are 36 chars with dashes — use them as-is.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrPrefix)) return idOrPrefix;
  const matches = items.filter(i => i.id.startsWith(idOrPrefix.toLowerCase()));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) {
    console.error(chalk.red(`✗ no ${kind} matching "${idOrPrefix}"`));
    process.exit(1);
  }
  console.error(chalk.red(`✗ "${idOrPrefix}" is ambiguous — matches ${matches.length} ${kind}s. Use more characters.`));
  process.exit(1);
}

// `ch change list` prints an 8-char ID prefix, but the API matches the full
// UUID exactly. Resolve a user-supplied prefix (or full ID) to the full ID by
// listing the repo's changes client-side and prefix-matching. A full UUID
// passes straight through without a lookup.
export async function resolveChangeId(
  client: ApiClient,
  ns: string,
  repo: string,
  idOrPrefix: string,
): Promise<string> {
  // Full UUIDs are 36 chars with dashes — skip the list call entirely.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrPrefix)) return idOrPrefix;
  const { changes } = await client.request<{ changes: Array<{ id: string }> }>("GET", `/api/v1/repos/${ns}/${repo}/changes`);
  return resolveIdPrefix(changes, idOrPrefix, "change");
}
