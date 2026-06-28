import type { Context, Next } from "hono";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const WINDOW_S = 60;
const DEFAULT_MAX = 100;

// Resolves the real client IP behind trusted proxies. Naive XFF[0] is spoofable, so
// prefer Cloudflare's CF-Connecting-IP (prod), else strip N trusted hops from the right
// of the XFF chain per CLAWHUB_TRUSTED_PROXY_COUNT; with no config XFF is untrusted.
export function clientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf.trim(); // Cloudflare sets this to the true client IP; it's the prod edge.
  const trustedHops = Number.parseInt(process.env.CLAWHUB_TRUSTED_PROXY_COUNT ?? "", 10);
  if (Number.isInteger(trustedHops) && trustedHops >= 0) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
      // Strip the N rightmost (trusted) hops; the leftmost-untrusted entry is spoofable, so index from the right.
      const ip = parts[parts.length - 1 - trustedHops];
      if (ip) return ip;
    }
  }
  // No trusted-proxy config: XFF is untrusted (spoofable) so prefer x-real-ip; XFF requires CLAWHUB_TRUSTED_PROXY_COUNT.
  return c.req.header("x-real-ip")?.trim() ?? "anon";
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

export function distributedRateLimit(opts: { max?: number; routePrefix?: string; match?: RegExp; keyPrefix?: string } = {}) {
  const max = opts.max ?? DEFAULT_MAX;
  const prefix = opts.routePrefix ?? "/api/";
  const keyPrefix = opts.keyPrefix ?? "api";
  return async (c: Context, next: Next) => {
    if (opts.match ? !opts.match.test(c.req.path) : !c.req.path.startsWith(prefix)) return next();
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
