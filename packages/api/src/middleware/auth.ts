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

/**
 * Optional auth — for the public browse surface. If a valid Bearer token is
 * present it sets `tokenPayload` (so a logged-in member following a public link
 * into their own private repo still resolves with full access); a missing or
 * invalid token is NOT an error — the request continues anonymously and
 * downstream authorization (repoAccessFor with a null caller) admits public
 * repos only. Never throws, so it cannot turn a public read into a 401.
 */
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const header = c.req.header("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) {
    try {
      c.set("tokenPayload", await verifyTokenCached(m[1]));
    } catch {
      // Invalid/expired token → treat as anonymous rather than reject.
    }
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
    // `humans-do-not-push` is the documented hard invariant. The git-http route
    // turns this reason into a self-documenting 403 with a hint pointing at
    // agent registration + the onboarding skill — see routes/git-http.ts.
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
    // `humans-do-not-push` is the documented hard invariant. The git-http route
    // turns this reason into a self-documenting 403 with a hint pointing at
    // agent registration + the onboarding skill — see routes/git-http.ts.
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
