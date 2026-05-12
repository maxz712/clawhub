import type { Context, Next } from "hono";
import { verifyToken, type TokenPayload } from "../services/auth.js";
import { verifyTokenCached } from "../services/token-cache.js";
import { AuthError } from "../services/errors.js";

declare module "hono" {
  interface ContextVariableMap {
    tokenPayload: TokenPayload;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new AuthError("missing bearer token");
  try {
    const payload = await verifyTokenCached(m[1]);
    c.set("tokenPayload", payload);
  } catch {
    throw new AuthError("invalid token");
  }
  await next();
}

export interface GitAuthResult {
  kind: "none" | "agent" | "rejected";
  agentId?: string;
  agentName?: string;
  reason?: string;
}

/**
 * Git HTTP Basic auth: username MUST be literally "agent-token", password is the agent JWT.
 * User JWTs are rejected outright (humans-do-not-push).
 *
 * Sync path retained for callers that need a non-async decision; prefer the async
 * variant on hot paths so the Redis token cache participates.
 */
export function authenticateGitRequest(c: Context): GitAuthResult {
  const parsed = parseBasic(c.req.header("authorization") ?? "");
  if (parsed.kind !== "ok") return parsed.result;
  try {
    const p = verifyToken(parsed.password);
    if (p.kind !== "agent") return { kind: "rejected", reason: "humans-do-not-push" };
    return { kind: "agent", agentId: p.agentId, agentName: p.name };
  } catch {
    return { kind: "rejected", reason: "invalid_token" };
  }
}

/**
 * Async git auth — verifies via the Redis-backed token cache.
 * Falls back to direct `jwt.verify` on cache miss, so behavior is identical to
 * `authenticateGitRequest` but JWT verification cost is amortized across pushes.
 */
export async function authenticateGitRequestCached(c: Context): Promise<GitAuthResult> {
  const parsed = parseBasic(c.req.header("authorization") ?? "");
  if (parsed.kind !== "ok") return parsed.result;
  try {
    const p = await verifyTokenCached(parsed.password);
    if (p.kind !== "agent") return { kind: "rejected", reason: "humans-do-not-push" };
    return { kind: "agent", agentId: p.agentId, agentName: p.name };
  } catch {
    return { kind: "rejected", reason: "invalid_token" };
  }
}

type ParsedBasic =
  | { kind: "ok"; password: string }
  | { kind: "err"; result: GitAuthResult };

function parseBasic(header: string): ParsedBasic {
  const m = header.match(/^Basic\s+(.+)$/i);
  if (!m) return { kind: "err", result: { kind: "none" } };
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon === -1) return { kind: "err", result: { kind: "rejected", reason: "bad_basic_auth" } };
  const user = decoded.slice(0, colon);
  const pw = decoded.slice(colon + 1);
  if (user !== "agent-token") return { kind: "err", result: { kind: "rejected", reason: "humans-do-not-push" } };
  return { kind: "ok", password: pw };
}
