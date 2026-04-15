import chalk from "chalk";
import { loadConfig } from "./config.js";

export type TokenKind = "user" | "agent";

export class ApiClient {
  constructor(private readonly cfg = loadConfig()) {}

  get server(): string { return this.cfg.server; }

  async request<T = unknown>(method: string, path: string, opts: { body?: unknown; token?: string; tokenKind?: TokenKind } = {}): Promise<T> {
    const token = opts.token ?? (opts.tokenKind === "agent" ? this.cfg.agentToken : this.cfg.userToken) ?? this.cfg.userToken ?? this.cfg.agentToken;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const res = await fetch(`${this.cfg.server}${path}`, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = (data && typeof data === "object" && "message" in data) ? (data as { message: string }).message : `${res.status} ${res.statusText}`;
      console.error(chalk.red(`✗ ${msg}`));
      process.exit(1);
    }
    return data as T;
  }
}
