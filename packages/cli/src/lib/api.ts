import chalk from "chalk";
import { loadConfig } from "./config.js";

export type TokenKind = "user" | "agent";

// Thrown only when a caller passes `throwOnError: true`, so it can recover from
// (e.g.) a 409 instead of the default exit-on-error behavior. Carries the HTTP
// status so callers can branch on it (e.g. conflict → recovery hint).
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  constructor(private readonly cfg = loadConfig()) {}

  get server(): string { return this.cfg.server; }

  async request<T = unknown>(method: string, path: string, opts: { body?: unknown; token?: string; tokenKind?: TokenKind; throwOnError?: boolean } = {}): Promise<T> {
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
      // Opt-in: let the caller handle the failure (e.g. surface a recovery hint)
      // instead of exiting. Default stays exit-on-error so existing callers are
      // unchanged.
      if (opts.throwOnError) throw new ApiError(msg, res.status);
      console.error(chalk.red(`✗ ${msg}`));
      process.exit(1);
    }
    return data as T;
  }
}
