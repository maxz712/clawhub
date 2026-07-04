import Redis from "ioredis";
import type { Tenant } from "./platform-billing.js";
import { log } from "./logger.js";

// D10 · Atomic spend/abuse enforcement. The naive "sum platform_usage at dispatch"
// gate has a read-then-act race (two concurrent dispatches both see under-cap) AND
// a scope hole (per-repo caps are bypassable by minting repos). This module closes
// both: per-TENANT (org XOR user) atomic Redis reservations debited BEFORE the
// container starts, refunded on abort. `platform_usage` stays the authoritative $
// AUDIT ledger; THESE counters are the enforcement. Fail-OPEN when Redis is down —
// the per-tenant $ budget and the OpenRouter prepaid wall still bound spend, so a
// Redis blip never takes review down or lets spend run truly unbounded.

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const MONTH_TTL_S = 40 * 24 * 3600;
const DAY_TTL_S = 2 * 24 * 3600;
const DEDUP_TTL_S = 14 * 24 * 3600;

let client: Redis | null = null;
// NB: unlike a one-shot lock, the quota counters must RECOVER after a Redis blip — a
// permanent disable would silently defeat every cap (incl. the global ceiling) for the
// process lifetime. So we keep the client and let ioredis auto-reconnect; each call
// fails-open individually while down (commands reject fast with enableOfflineQueue:false),
// and resumes enforcing the moment Redis returns.
function getClient(): Redis | null {
  if (client) return client;
  try {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true, connectTimeout: 1_500,
      retryStrategy: (times) => Math.min(times * 200, 5_000), // keep reconnecting, backing off to 5s
    });
    client.on("error", () => { /* swallow; per-call try/catch handles the failure */ });
    client.connect().catch(() => { /* ioredis retries via retryStrategy — do NOT disable */ });
    return client;
  } catch { return null; }
}

function tenantKey(t: Tenant): string { return t.orgId ? `o:${t.orgId}` : t.userId ? `u:${t.userId}` : "anon"; }
// UTC month/day buckets. Passed in (not Date.now-derived here) so callers that need
// determinism can, but default to the current UTC period.
function ym(now = new Date()): string { return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`; }
function ymd(now = new Date()): string { return `${ym(now)}-${String(now.getUTCDate()).padStart(2, "0")}`; }

export interface ReserveResult { ok: boolean; monthlyUsed: number; dailyUsed: number; degraded?: boolean; over?: "month" | "day" }

/**
 * Atomically reserve ONE review slot against a tenant's monthly + daily hard caps.
 * INCRs both counters, and if EITHER exceeds its limit refunds both (DECR) and
 * denies. Two concurrent reservations get distinct INCR values, so at most `limit`
 * pass — the read-then-act race is gone. `Infinity` limit = no hard cap on that axis
 * (the counter still tracks usage for billing/telemetry). Fail-open on Redis error.
 */
export async function reserveReviewSlot(t: Tenant, monthlyLimit: number, dailyLimit: number): Promise<ReserveResult> {
  const r = getClient();
  if (!r) return { ok: true, monthlyUsed: 0, dailyUsed: 0, degraded: true };
  const mKey = `clawhub:rev:m:${tenantKey(t)}:${ym()}`;
  const dKey = `clawhub:rev:d:${tenantKey(t)}:${ymd()}`;
  try {
    const m = await r.incr(mKey);
    const d = await r.incr(dKey);
    if (m === 1) await r.expire(mKey, MONTH_TTL_S);
    if (d === 1) await r.expire(dKey, DAY_TTL_S);
    const overM = Number.isFinite(monthlyLimit) && m > monthlyLimit;
    const overD = Number.isFinite(dailyLimit) && d > dailyLimit;
    if (overM || overD) {
      await r.decr(mKey); await r.decr(dKey);
      return { ok: false, monthlyUsed: m, dailyUsed: d, over: overM ? "month" : "day" };
    }
    return { ok: true, monthlyUsed: m, dailyUsed: d };
  } catch (e) {
    log("warn", "quota_reserve_failed", { err: (e as Error).message });
    return { ok: true, monthlyUsed: 0, dailyUsed: 0, degraded: true };
  }
}

/** Refund a reserved review slot (DECR both) when the run never actually spent —
 *  infra abort, immediate failure, or a downstream deny after the reserve.
 *  NB: uses the CURRENT period keys. A refund that crosses a UTC month/day boundary
 *  (reserve at 23:59:59.x, refund milliseconds later at 00:00:00.x) would decrement
 *  the new period by 1 — a sub-second window per period, self-healing, accepted as a
 *  ±1 rounding on a soft counter, never a money or hard-cap error. */
export async function refundReviewSlot(t: Tenant): Promise<void> {
  const r = getClient();
  if (!r) return;
  try { await r.decr(`clawhub:rev:m:${tenantKey(t)}:${ym()}`); await r.decr(`clawhub:rev:d:${tenantKey(t)}:${ymd()}`); }
  catch { /* best-effort refund */ }
}

/**
 * Free-tier platform review is capped to N distinct repos/month (a minted-repo
 * abuse guard, complementing the per-tenant review count). An already-counted repo
 * always passes; a NEW repo is admitted only while the set has room. Fail-open.
 */
export async function reserveRepoSlot(t: Tenant, repoId: string, maxRepos: number): Promise<{ ok: boolean; added: boolean }> {
  if (!Number.isFinite(maxRepos)) return { ok: true, added: false };
  const r = getClient();
  if (!r) return { ok: true, added: false };
  const key = `clawhub:revrepos:${tenantKey(t)}:${ym()}`;
  try {
    if (await r.sismember(key, repoId)) return { ok: true, added: false };
    const size = await r.scard(key);
    if (size >= maxRepos) return { ok: false, added: false };
    await r.sadd(key, repoId);
    if (size === 0) await r.expire(key, MONTH_TTL_S);
    return { ok: true, added: true };  // caller must releaseRepoSlot on abort
  } catch { return { ok: true, added: false }; }
}

/** Release a repo slot added by THIS dispatch (SREM) when the dispatch then aborted,
 *  so a failed review doesn't permanently consume a free tenant's reviewMaxRepos. Only
 *  call when reserveRepoSlot reported `added:true` — a repo with other reviews stays. */
export async function releaseRepoSlot(t: Tenant, repoId: string): Promise<void> {
  const r = getClient();
  if (!r) return;
  try { await r.srem(`clawhub:revrepos:${tenantKey(t)}:${ym()}`, repoId); } catch { /* will TTL out */ }
}

/**
 * Per-commit dedup: claim (changeId, headCommit) so a republish/force-push of an
 * ALREADY-reviewed head is a no-op. Returns true iff THIS is the first claim.
 * Released on abort so a genuinely failed first attempt can retry. Fail-open.
 */
export async function claimReviewOnce(changeId: string, headCommit: string): Promise<boolean> {
  const r = getClient();
  if (!r) return true;
  try { return (await r.set(`clawhub:revonce:${changeId}:${headCommit}`, "1", "EX", DEDUP_TTL_S, "NX")) === "OK"; }
  catch { return true; }
}
export async function releaseReviewOnce(changeId: string, headCommit: string): Promise<void> {
  const r = getClient();
  if (!r) return;
  try { await r.del(`clawhub:revonce:${changeId}:${headCommit}`); } catch { /* will TTL out */ }
}

/** Per-commit dedup for platform VERIFY — a SEPARATE namespace from review so the two
 *  (both firing on change.opened) don't block each other. Prevents a force-push back to
 *  an already-verified head from re-spending the $2 verify. Released on abort. */
export async function claimVerifyOnce(changeId: string, headCommit: string): Promise<boolean> {
  const r = getClient();
  if (!r) return true;
  try { return (await r.set(`clawhub:vfyonce:${changeId}:${headCommit}`, "1", "EX", DEDUP_TTL_S, "NX")) === "OK"; }
  catch { return true; }
}
export async function releaseVerifyOnce(changeId: string, headCommit: string): Promise<void> {
  const r = getClient();
  if (!r) return;
  try { await r.del(`clawhub:vfyonce:${changeId}:${headCommit}`); } catch { /* will TTL out */ }
}

// ── Global platform spend ceiling (the $100 backstop) ──────────────────────
// A single hard ceiling on ALL platform-key spend across every tenant, so no amount
// of tenants/abuse can exceed it — sits UNDER the OpenRouter prepaid wall as a
// server-side stop. $-denominated (spend is only known post-call), tracked as a
// Redis running total bumped at meter time and read O(1) at dispatch + gateway.

/** The global monthly ceiling in micro-USD (env CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP,
 *  in whole USD; default $100). <=0 disables the ceiling. */
export function globalCapMicroUsd(): number {
  const usd = Number(process.env.CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP ?? 100);
  return Number.isFinite(usd) && usd > 0 ? Math.floor(usd * 1_000_000) : 0;
}

/** Add to the global month-to-date platform spend (called from the gateway meter). */
export async function addGlobalSpend(micro: number): Promise<void> {
  if (!(micro > 0)) return;
  const r = getClient();
  if (!r) return;
  const key = `clawhub:global-spend:${ym()}`;
  try { const v = await r.incrby(key, Math.ceil(micro)); if (v === Math.ceil(micro)) await r.expire(key, MONTH_TTL_S); }
  catch { /* audit ledger (platform_usage) is still authoritative */ }
}

/** Month-to-date global platform spend (micro-USD) from the Redis running total. */
export async function globalSpendMicroUsd(): Promise<number> {
  const r = getClient();
  if (!r) return 0;
  try { return Number(await r.get(`clawhub:global-spend:${ym()}`)) || 0; }
  catch { return 0; }
}

/** True when the global ceiling is set and month-to-date spend has reached it.
 *  Fail-open on Redis error — the OpenRouter prepaid balance is the hard backstop. */
export async function globalCapExceeded(): Promise<boolean> {
  const cap = globalCapMicroUsd();
  if (cap <= 0) return false;
  return (await globalSpendMicroUsd()) >= cap;
}

// ── Per-tenant month-spend cache (N7) ──────────────────────────────────────
// The budget gate SUMs platform_usage on every gateway-authorized draw. Under
// load that SUM shows up in gateway p99. This caches it per tenant for a short
// TTL: the SUM collapses to ~once/tenant/window. The ledger (platform_usage)
// stays authoritative — this is only the read fast-path, staleness is bounded by
// ttlS, and the per-review 50k ceiling + global cap bound any overshoot. Fail-open.
export async function cachedTenantMonthlySpend(t: Tenant, loader: () => Promise<number>, ttlS = Number(process.env.CLAWHUB_TENANT_SPEND_CACHE_TTL_S ?? 20)): Promise<number> {
  const r = getClient();
  if (!r || (!t.orgId && !t.userId)) return loader();
  const key = `clawhub:tenant-spend:${tenantKey(t)}:${ym()}`;
  try {
    const cached = await r.get(key);
    if (cached !== null) return Number(cached) || 0;
    const v = await loader();
    await r.set(key, Math.max(0, Math.floor(v)), "EX", Math.max(1, ttlS));
    return v;
  } catch { return loader(); }
}

/** Invalidate a tenant's cached month spend (e.g. after a manual billing adjustment). */
export async function invalidateTenantSpendCache(t: Tenant): Promise<void> {
  const r = getClient();
  if (!r) return;
  try { await r.del(`clawhub:tenant-spend:${tenantKey(t)}:${ym()}`); } catch { /* TTL will expire it */ }
}

// ── Per-tenant token counters (free-tier token caps) ───────────────────────
// Free tenants also carry a monthly + daily INPUT-token ceiling (a giant-diff abuse
// guard beyond the per-review 50k truncation). Tokens are known post-call, so these
// are bumped at meter time and checked at the NEXT dispatch (eventually consistent;
// the per-review ceiling bounds any single overshoot).

export async function addTenantInputTokens(t: Tenant, tokens: number): Promise<void> {
  if (!(tokens > 0)) return;
  const r = getClient();
  if (!r) return;
  const mKey = `clawhub:tok:m:${tenantKey(t)}:${ym()}`;
  const dKey = `clawhub:tok:d:${tenantKey(t)}:${ymd()}`;
  try {
    const m = await r.incrby(mKey, Math.ceil(tokens)); if (m === Math.ceil(tokens)) await r.expire(mKey, MONTH_TTL_S);
    const d = await r.incrby(dKey, Math.ceil(tokens)); if (d === Math.ceil(tokens)) await r.expire(dKey, DAY_TTL_S);
  } catch { /* best-effort */ }
}

/** True when a tenant is over its monthly OR daily input-token ceiling. Fail-open. */
export async function tenantTokensExceeded(t: Tenant, monthlyLimit: number, dailyLimit: number): Promise<boolean> {
  if (!Number.isFinite(monthlyLimit) && !Number.isFinite(dailyLimit)) return false;
  const r = getClient();
  if (!r) return false;
  try {
    const [m, d] = await Promise.all([r.get(`clawhub:tok:m:${tenantKey(t)}:${ym()}`), r.get(`clawhub:tok:d:${tenantKey(t)}:${ymd()}`)]);
    if (Number.isFinite(monthlyLimit) && Number(m) >= monthlyLimit) return true;
    if (Number.isFinite(dailyLimit) && Number(d) >= dailyLimit) return true;
    return false;
  } catch { return false; }
}
