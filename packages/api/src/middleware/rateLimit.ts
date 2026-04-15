import type { Context, Next } from "hono";

const WINDOW_MS = 60_000;
const MAX = 100;
const store = new Map<string, { count: number; reset: number }>();

export async function rateLimit(c: Context, next: Next) {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "anon";
  const now = Date.now();
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
