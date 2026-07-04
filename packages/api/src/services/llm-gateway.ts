import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciRuns, platformUsage, repositories, standingAgents } from "../models/schema.js";
import { priceUsageMicroUsd, microUsdToCents, type UsageTokens } from "./llm-pricing.js";
import { recordCost } from "./cost-ledger.js";
import { addGlobalSpend, addTenantInputTokens } from "./platform-quota.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";

// The API-side LLM gateway (M3 custody). The egress proxy is a CONNECT tunnel and
// sees no TLS plaintext, so metering has to live where the request is decrypted —
// here. A platform-keyed run's container gets a per-run GATEWAY TOKEN as its
// "API key" + ANTHROPIC_BASE_URL pointing at this gateway; the real platform key
// never enters the container. Prompt-injection → key-exfil is closed by
// construction, and every token the platform key serves is metered.

export function hashGatewayToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a per-run gateway token and pin its hash to the run. The raw token is the
 * container's "ANTHROPIC_API_KEY"; only its sha256 is stored. Call under the same
 * advisory lock that creates the run so a run has at most one live token.
 */
export async function mintGatewayToken(db: DB, runId: string): Promise<string> {
  const token = `chgw_${randomBytes(24).toString("base64url")}`;
  await db.update(ciRuns).set({ gatewayTokenHash: hashGatewayToken(token) }).where(eq(ciRuns.id, runId));
  return token;
}

/** Revoke a run's gateway token (called when the run goes terminal). */
export async function revokeGatewayToken(db: DB, runId: string): Promise<void> {
  await db.update(ciRuns).set({ gatewayTokenHash: null }).where(eq(ciRuns.id, runId));
}

export interface GatewayRun {
  runId: string;
  repoId: string | null;
  changeId: string | null;
  agentId: string | null;
  orgId: string | null;
  userId: string | null;
}

/**
 * Resolve an incoming gateway token to its RUNNING run + denormalized billing
 * attribution. Returns null when the token is unknown or its run is no longer
 * running — so a token is dead the instant the run goes terminal.
 */
export async function resolveGatewayRun(db: DB, token: string): Promise<GatewayRun | null> {
  if (!token) return null;
  const hash = hashGatewayToken(token);
  const run = (await db.select({
    id: ciRuns.id, status: ciRuns.status, repoId: ciRuns.repoId, changeId: ciRuns.changeId,
    standingAgentId: ciRuns.standingAgentId,
  }).from(ciRuns).where(eq(ciRuns.gatewayTokenHash, hash)).limit(1))[0];
  if (!run || run.status !== "running") return null;

  let agentId: string | null = null;
  if (run.standingAgentId) {
    const sa = (await db.select({ agentId: standingAgents.agentId }).from(standingAgents).where(eq(standingAgents.id, run.standingAgentId)).limit(1))[0];
    agentId = sa?.agentId ?? null;
  }
  let orgId: string | null = null, userId: string | null = null;
  if (run.repoId) {
    const repo = (await db.select({ nsType: repositories.namespaceType, nsId: repositories.namespaceId }).from(repositories).where(eq(repositories.id, run.repoId)).limit(1))[0];
    if (repo?.nsType === "org") orgId = repo.nsId;
    else if (repo?.nsType === "user") userId = repo.nsId;
  }
  return { runId: run.id, repoId: run.repoId, changeId: run.changeId, agentId, orgId, userId };
}

/**
 * Record one gateway request into platform_usage (authoritative) + mirror into
 * cost_ledger when an agent is attributable. `partial` marks an input-only meter
 * (written at message_start so a severed stream still records input spend); the
 * finalize call at message_delta upserts the same row with output tokens.
 */
export async function recordPlatformUsage(db: DB, args: {
  run: GatewayRun;
  model: string;
  usage: UsageTokens;
  usageRowId?: string | null; // to finalize a row opened at message_start
  meta?: Record<string, unknown>;
  // Authoritative cost in micro-USD when the upstream reports it (OpenRouter's
  // usage.cost). Bypasses the per-family price table — no drift, no undercharge on
  // an open-model slug the Anthropic table wouldn't recognize.
  costMicroUsd?: number;
}): Promise<string> {
  const costMicroUsd = args.costMicroUsd != null && Number.isFinite(args.costMicroUsd)
    ? Math.max(0, Math.ceil(args.costMicroUsd))
    : priceUsageMicroUsd(args.model, args.usage);
  const values = {
    runId: args.run.runId, changeId: args.run.changeId, repoId: args.run.repoId,
    orgId: args.run.orgId, userId: args.run.userId, agentId: args.run.agentId,
    model: args.model,
    inputTokens: args.usage.inputTokens, outputTokens: args.usage.outputTokens,
    cacheReadTokens: args.usage.cacheReadTokens ?? 0, cacheWriteTokens: args.usage.cacheWriteTokens ?? 0,
    costMicroUsd, meta: args.meta ?? {},
  };
  let rowId = args.usageRowId ?? null;
  let priorCost = 0;
  if (rowId) {
    const prev = (await db.select({ c: platformUsage.costMicroUsd }).from(platformUsage).where(eq(platformUsage.id, rowId)).limit(1))[0];
    priorCost = prev?.c ?? 0;
    await db.update(platformUsage).set(values).where(eq(platformUsage.id, rowId));
  } else {
    rowId = (await db.insert(platformUsage).values(values).returning({ id: platformUsage.id }))[0].id;
  }
  metrics.inc("clawhub_platform_usage_total", { model: familyOf(args.model) });
  metrics.inc("clawhub_platform_cost_micro_usd_total", { model: familyOf(args.model) }, costMicroUsd);
  // D10 enforcement feeds (Redis counters, best-effort, never block metering):
  //  • global $ ceiling — bump by the DELTA vs this row's prior cost, so the
  //    streaming start→final two-write case never double-counts.
  //  • free-tier input-token cap — bump input tokens ONCE per row (on the insert;
  //    the streaming finalize update carries the same input, so skip it there).
  const deltaCost = costMicroUsd - priorCost;
  if (deltaCost > 0) void addGlobalSpend(deltaCost);
  if (!args.usageRowId && args.usage.inputTokens > 0) {
    void addTenantInputTokens({ orgId: args.run.orgId, userId: args.run.userId }, args.usage.inputTokens);
  }
  // Mirror into cost_ledger only when we can attribute an agent (its column is
  // NOT NULL). platform_usage is the source of truth either way. recordCost is a
  // plain INSERT (no upsert), and a streamed request records TWICE here (input-only
  // at message_start, full at message_delta) — so mirror the DELTA, exactly like
  // the global-cap + input-token feeds above, or the two writes double-count the
  // input cost into the agent's monthSpend / org spend / leaderboard (and could
  // trip the BYO cost budget early). Input tokens are attributed once (on the
  // insert); output tokens flow in on the finalize; cents = the per-write delta so
  // the writes sum to the full cost exactly once.
  if (args.run.agentId && deltaCost > 0) {
    try {
      await recordCost(db, {
        agentId: args.run.agentId, repoId: args.run.repoId, changeId: args.run.changeId,
        inputTokens: args.usageRowId ? 0 : args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        cachedTokens: args.usageRowId ? 0 : (args.usage.cacheReadTokens ?? 0),
        costCents: microUsdToCents(deltaCost), model: args.model, kind: "platform_llm",
      });
    } catch (e) { log("warn", "platform_usage_ledger_mirror_failed", { err: (e as Error).message }); }
  }
  return rowId;
}

function familyOf(model: string): string {
  const m = (model || "").toLowerCase();
  for (const f of ["haiku", "sonnet", "opus", "deepseek", "qwen", "llama", "glm"]) if (m.includes(f)) return f;
  return "other";
}
