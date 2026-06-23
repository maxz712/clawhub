import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(homedir(), ".clawhub");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface CliConfig {
  server: string;
  userToken?: string;
  // The logged-in human's resolved handle (username). Set at login/register; it
  // is the namespace a human pushes their OWN code under and the git Basic-auth
  // username for human push.
  userHandle?: string;
  agentToken?: string;
  agentName?: string;
  // The namespace the caller OWNS repos under (their username, or a headless
  // agent's same-named service account). Drives the git remote path.
  ownerHandle?: string;
}

// Hosted platform by default; self-hosters point elsewhere with
// `ch server <url>` or CLAWHUB_API_URL.
const DEFAULT: CliConfig = { server: process.env.CLAWHUB_API_URL ?? "https://api.useclawhub.com" };

export function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT };
  try {
    return { ...DEFAULT, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveConfig(cfg: CliConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
