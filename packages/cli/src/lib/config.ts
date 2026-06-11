import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(homedir(), ".clawhub");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface CliConfig {
  server: string;
  userToken?: string;
  agentToken?: string;
  agentName?: string;
}

// Hosted platform by default; self-hosters point elsewhere with
// `clawhub server <url>` or CLAWHUB_API_URL.
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
