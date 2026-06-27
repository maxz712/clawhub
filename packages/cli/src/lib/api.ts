import chalk from "chalk";
import { loadConfig } from "./config.js";

export type TokenKind = "user" | "agent";

// Thrown only when a caller passes `throwOnError: true`, so it can recover from
// (e.g.) a 409 instead of the default exit-on-error behavior. Carries the HTTP
// status AND the machine-readable `error` code from the body (when present) so
// callers can branch on it (e.g. conflict → recovery hint, totp_required → prompt).
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
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
    // A proxy/gateway error (or any misbehaving endpoint) can return non-JSON —
    // don't let JSON.parse throw an opaque SyntaxError over the real HTTP error.
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = res.ok ? null : { message: text.slice(0, 300) }; }
    }
    if (!res.ok) {
      const obj = (data && typeof data === "object") ? data as { message?: string; error?: string } : {};
      // Routes are inconsistent: some return { message }, others { error }.
      const msg = obj.message ?? obj.error ?? `${res.status} ${res.statusText}`;
      // Opt-in: let the caller handle the failure (e.g. surface a recovery hint)
      // instead of exiting. Default stays exit-on-error so existing callers are
      // unchanged.
      if (opts.throwOnError) throw new ApiError(msg, res.status, obj.error);
      console.error(chalk.red(`✗ ${msg}`));
      process.exit(1);
    }
    return data as T;
  }
}
