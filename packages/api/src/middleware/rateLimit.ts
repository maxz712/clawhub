import type { Context, Next } from "hono";
import { clientIp } from "./rate-limit-redis.js";

const WINDOW_MS = 60_000;
const MAX = 100;
const MAX_ENTRIES = 50_000; // Cap so a spoof/DoS of distinct keys can't grow this module-level Map unbounded.
const store = new Map<string, { count: number; reset: number }>();

export async function rateLimit(c: Context, next: Next) {
  const ip = clientIp(c); // Trusted-proxy-aware client IP so XFF spoofing can't bypass the per-IP limit.
  const now = Date.now();
  // Bound memory: once at cap, drop the whole store (next window rebuilds it) so attacker keys can't accumulate.
  if (store.size >= MAX_ENTRIES) store.clear();
  const entry = store.get(ip);
  if (!entry || entry.reset < now) {
    store.set(ip, { count: 1, reset: now + WINDOW_MS });
  } else {
    entry.count++;
    if (entry.count > MAX) {
      return c.json({ error: "rate_limited" }, 429);
    }
  }
  await next();
}
