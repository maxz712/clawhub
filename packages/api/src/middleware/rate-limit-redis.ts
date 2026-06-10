import type { Context, Next } from "hono";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const WINDOW_S = 60;
const DEFAULT_MAX = 100;

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
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? c.req.header("x-real-ip") ?? "anon";
    try {
      const r = getClient();
      const key = `${keyPrefix}:${bucket(ip)}`;
      const n = await r.incr(key);
      if (n === 1) await r.expire(key, WINDOW_S);
      c.header("x-ratelimit-limit", String(max));
      c.header("x-ratelimit-remaining", String(Math.max(0, max - n)));
      if (n > max) return c.json({ error: "rate_limited" }, 429);
    } catch {
      // If Redis is down we fail open. The in-memory fallback at `middleware/rateLimit.ts`
      // can be mounted alongside for belt-and-braces.
    }
    await next();
  };
}
