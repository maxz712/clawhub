import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ClawForgeConfig {
  api_url: string;
  token: string;
}

const CONFIG_DIR = join(homedir(), ".clawforge");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: ClawForgeConfig = {
  api_url: "http://localhost:3000",
  token: "",
};

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function getConfig(): ClawForgeConfig {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ClawForgeConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function setConfig(key: keyof ClawForgeConfig, value: string): void {
  ensureConfigDir();
  const config = getConfig();
  config[key] = value;
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function getToken(): string {
  return getConfig().token;
}

export function getApiUrl(): string {
  return getConfig().api_url;
}
