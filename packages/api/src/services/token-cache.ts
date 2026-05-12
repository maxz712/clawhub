import { createHash } from "node:crypto";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import { verifyToken, type TokenPayload } from "./auth.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const CACHE_TTL_S = Number(process.env.CLAWHUB_TOKEN_CACHE_TTL_S ?? 60);
const CACHE_PREFIX = "clawhub:tok:v1:";

let client: Redis | null = null;
let clientDisabled = false;
function getClient(): Redis | null {
  if (clientDisabled) return null;
  if (client) return client;
  client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectTimeout: 1_500,
  });
  client.on("error", () => { /* swallow so unhandled-error event doesn't crash */ });
  client.connect().catch(() => { clientDisabled = true; });
  return client;
}

function keyFor(token: string): string {
  return CACHE_PREFIX + createHash("sha256").update(token).digest("hex");
}

interface Cached { payload: TokenPayload; exp?: number }

const local = new Map<string, { v: Cached; expiresAt: number }>();
const LOCAL_TTL_MS = 5_000;

function fromLocal(token: string): TokenPayload | null {
  const e = local.get(keyFor(token));
  if (!e) return null;
  if (Date.now() > e.expiresAt) { local.delete(keyFor(token)); return null; }
  if (e.v.exp && Date.now() / 1000 >= e.v.exp) { local.delete(keyFor(token)); return null; }
  return e.v.payload;
}

function toLocal(token: string, c: Cached) {
  local.set(keyFor(token), { v: c, expiresAt: Date.now() + LOCAL_TTL_MS });
}

export async function verifyTokenCached(token: string): Promise<TokenPayload> {
  const localHit = fromLocal(token);
  if (localHit) return localHit;

  const r = getClient();
  if (r && r.status === "ready") {
    try {
      const raw = await r.get(keyFor(token));
      if (raw) {
        const c = JSON.parse(raw) as Cached;
        if (!c.exp || Date.now() / 1000 < c.exp) {
          toLocal(token, c);
          return c.payload;
        }
      }
    } catch { /* fall through */ }
  }

  // Cache miss — verify directly and populate.
  const payload = verifyToken(token);
  let exp: number | undefined;
  try {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    exp = decoded?.exp;
  } catch { /* no exp */ }
  const cached: Cached = { payload, exp };
  toLocal(token, cached);
  if (r && r.status === "ready") {
    try {
      const ttl = exp ? Math.max(1, Math.min(CACHE_TTL_S, exp - Math.floor(Date.now() / 1000))) : CACHE_TTL_S;
      await r.set(keyFor(token), JSON.stringify(cached), "EX", ttl);
    } catch { /* ignore */ }
  }
  return payload;
}

export function invalidateTokenCache(token: string): Promise<void> {
  local.delete(keyFor(token));
  const r = getClient();
  if (!r || r.status !== "ready") return Promise.resolve();
  return r.del(keyFor(token)).then(() => undefined).catch(() => undefined);
}

export function _resetTokenCacheForTests() {
  local.clear();
  clientDisabled = false;
  if (client) { try { client.disconnect(); } catch { /* ignore */ } client = null; }
}
