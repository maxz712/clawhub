import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const WINDOW_S = 60;
const DEFAULT_MAX = 100;

// THE canonical client-IP resolver — the sole bucket key for every per-IP limiter
// (auth/api/git/llm) AND the source for audit.ts:ipFromContext + users.ts. Header
// trust is OPT-IN: CF-Connecting-IP / X-Real-IP / X-Forwarded-For are all
// CLIENT-SUPPLIED and forgeable, so they are honoured ONLY when the operator
// declares a trusted edge via CLAWHUB_TRUSTED_PROXY_COUNT (#159). With no such
// declaration — the default self-host — the socket peer address (getConnInfo) is
// used: it is not forgeable over TCP, and it never collapses distinct clients
// into one shared bucket the way a constant fallback would.
export function clientIp(c: Context): string {
  const trustedHops = Number.parseInt(process.env.CLAWHUB_TRUSTED_PROXY_COUNT ?? "", 10);
  const trusted = Number.isInteger(trustedHops) && trustedHops >= 0;
  if (trusted) {
    // A single trusted header (e.g. CF-Connecting-IP on a Cloudflare edge) can be
    // named explicitly; the edge OVERWRITES it, so it is trustworthy only here.
    const named = (process.env.CLAWHUB_TRUSTED_PROXY_HEADER ?? "").trim().toLowerCase();
    if (named && named !== "x-forwarded-for") {
      const v = c.req.header(named);
      if (v) return v.trim();
    }
    // XFF: the real client is COUNT entries from the right (each trusted proxy
    // appends the address it received from; the leftmost entries are spoofable).
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map(p => p.trim()).filter(Boolean);
      const ip = parts[parts.length - trustedHops];
      if (ip) return ip;
    }
    // Declared edge but the header is absent: fall through to the socket peer.
  }
  // Default (or missing trusted header): the non-forgeable socket peer address.
  try {
    const addr = getConnInfo(c).remote.address;
    if (addr) return addr;
  } catch { /* no conn info (non-node runtime / unit test) */ }
  return "anon";
}

let client: Redis | null = null;
function getClient(): Redis {
  if (client) return client;
  client = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  client.connect().catch(() => { /* ignore; we'll fall back per-request */ });
  return client;
}

function bucket(ip: string): string {
  const sec = Math.floor(Date.now() / 1000 / WINDOW_S);
  return `clawhub:rl:${ip}:${sec}`;
}

export function distributedRateLimit(opts: { max?: number; routePrefix?: string; match?: RegExp; keyPrefix?: string; skip?: RegExp } = {}) {
  const max = opts.max ?? DEFAULT_MAX;
  const prefix = opts.routePrefix ?? "/api/";
  const keyPrefix = opts.keyPrefix ?? "api";
  return async (c: Context, next: Next) => {
    if (opts.match ? !opts.match.test(c.req.path) : !c.req.path.startsWith(prefix)) return next();
    // Carve-out: a path this limiter should NOT govern (e.g. the LLM gateway,
    // which has its own high-throughput bucket). Lets one broad limiter skip a
    // sub-path without a second, contradictory matcher.
    if (opts.skip?.test(c.req.path)) return next();
    const ip = clientIp(c); // Trusted-proxy-aware client IP so XFF spoofing can't bypass the per-IP limit.
    try {
      const r = getClient();
      const key = `${keyPrefix}:${bucket(ip)}`;
      const n = await r.incr(key);
      if (n === 1) await r.expire(key, WINDOW_S);
      c.header("x-ratelimit-limit", String(max));
      c.header("x-ratelimit-remaining", String(Math.max(0, max - n)));
      if (n > max) return c.json({ error: "rate_limited" }, 429);
    } catch {
      // Redis is down. Default fail-open so a Redis blip doesn't take the whole API down; the
      // in-memory fallback at `middleware/rateLimit.ts` can be mounted alongside for belt-and-braces.
      if (process.env.CLAWHUB_RATELIMIT_FAIL_CLOSED === "true") return c.json({ error: "rate_limiter_unavailable" }, 503); // Opt-in fail-closed: reject when the limiter can't be consulted.
    }
    await next();
  };
}
