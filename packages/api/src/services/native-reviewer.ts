import { createHash } from "node:crypto";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { EventBus } from "./events.js";
import { agents, changes, ciRuns, repoCollaborators, repositories, standingAgents } from "../models/schema.js";
import type { Change } from "../models/schema.js";
import type { Risk } from "./trailer-parser.js";
import { hashToken, randomToken, signToken } from "./auth.js";
import { seal } from "./secrets.js";
import { touchesBaselineSensitive } from "./merge-policy.js";
import { DEFAULT_HARNESS_IMAGE, dispatchStandingRun } from "./standing-agents.js";
import { platformProvider, platformModelForTier, reviewTier } from "./llm-catalog.js";
import { authorizePlatformReview, refundPlatformReview, tenantForRepo } from "./platform-billing.js";
import { planFor } from "./entitlements.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";

// The native ADVISORY reviewer (M4). One ClawHub-owned SYSTEM agent runs on every
// published Change through the existing change.opened dispatch spine, review-only
// (never executes repo code), gateway-keyed (the platform key never enters the
// container). Its verdict is advisory — it INFORMS but never gates. "inference
// informs, determinism decides." Rollout is gated (D5); ships DARK by default.

export const NATIVE_REVIEWER_AGENT_NAME = "clawhub-native-reviewer";
export const NATIVE_REVIEWER_STANDING_NAME = "clawhub-native-reviewer";
const AUDIT_PCT = Number(process.env.CLAWHUB_NATIVE_REVIEW_AUDIT_PCT ?? 5);
// Global daily cap (backstop against a runaway spend before the M7 budgets land).
const GLOBAL_DAILY_CAP = Number(process.env.CLAWHUB_NATIVE_REVIEW_DAILY_CAP ?? 10000);

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export type ReviewModel = "haiku" | "sonnet";

export interface ModelSelectionInput {
  effectiveRisk: Risk;
  changedPaths: string[];
  authorRollbacks: number;
  changeId: string;
  headCommit: string;
}

export interface ModelSelection {
  model: ReviewModel;
  reason: string;
  audited: boolean;
}

/**
 * Deterministic model router (D6 locked params): Haiku for low/medium, Sonnet for
 * high/critical or any sensitive path. Author rollback history bumps one risk
 * level. A reproducible hash-seeded audit (sha256(changeId+head) % 100 < AUDIT_PCT)
 * promotes a share of low-risk changes to Sonnet so we keep measuring Haiku's
 * precision against a stronger model. Pure + deterministic → same change, same model.
 */
export function selectReviewModel(i: ModelSelectionInput): ModelSelection {
  let rank = RANK[i.effectiveRisk];
  const reasons: string[] = [`risk ${i.effectiveRisk}`];
  if (touchesBaselineSensitive(i.changedPaths)) {
    rank = Math.max(rank, RANK.high);
    reasons.push("sensitive path");
  }
  if (i.authorRollbacks > 0) {
    rank = Math.min(rank + 1, RANK.critical);
    reasons.push(`author has ${i.authorRollbacks} rollback(s)`);
  }
  // Hash-seeded Sonnet audit of low-risk changes — reproducible from the id+head.
  let audited = false;
  if (rank <= RANK.medium) {
    const h = createHash("sha256").update(`${i.changeId}:${i.headCommit}`).digest();
    if (h.readUInt16BE(0) % 100 < AUDIT_PCT) { audited = true; reasons.push("audit sample → Sonnet"); }
  }
  const model: ReviewModel = rank >= RANK.high || audited ? "sonnet" : "haiku";
  return { model, reason: reasons.join(", "), audited };
}

export interface DispatchDecisionInput {
  masterFlag: boolean;          // the platform-wide enable flag
  repoFlag: boolean | null;     // repositories.nativeReviewerEnabled (tri-state)
  isDraft: boolean;
  hasByoReviewer: boolean;      // a BYO mode=review agent already reviews this repo
  dailyCapReached: boolean;
}

/**
 * Pure dispatch gate. repoFlag===false is a hard opt-out; ===true forces ON (past
 * the BYO suppressor — the dogfood/force-on case). Otherwise the master flag +
 * the BYO auto-suppress + the daily cap decide. Drafts never dispatch.
 */
export function nativeReviewerDecision(i: DispatchDecisionInput): { dispatch: boolean; reason: string } {
  if (i.isDraft) return { dispatch: false, reason: "draft" };
  if (i.repoFlag === false) return { dispatch: false, reason: "repo_opt_out" };
  if (i.dailyCapReached) return { dispatch: false, reason: "daily_cap" };
  const forced = i.repoFlag === true;
  if (!forced) {
    if (!i.masterFlag) return { dispatch: false, reason: "master_off" };
    // BYO auto-suppress: a repo already running its OWN review-mode agent doesn't
    // also get the platform reviewer (avoid double review). A verify-mode BYO agent
    // does NOT suppress — it complements advisory review (pre-flight narrowing).
    if (i.hasByoReviewer) return { dispatch: false, reason: "byo_reviewer" };
  }
  return { dispatch: true, reason: forced ? "forced" : "default" };
}

/** Find-or-create the single ClawHub-owned system reviewer agent. Returns its token. */
export async function ensureNativeReviewerAgent(db: DB): Promise<{ agentId: string; token: string }> {
  const existing = (await db.select().from(agents).where(eq(agents.name, NATIVE_REVIEWER_AGENT_NAME)).limit(1))[0];
  if (existing) {
    // Re-issue a fresh token each boot so the sealed copy on the standing rows is
    // refreshed by ensureNativeReviewerForRepo; the old token is revoked.
    const token = signToken({ kind: "agent", agentId: existing.id, name: existing.name });
    await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, existing.id));
    return { agentId: existing.id, token };
  }
  const [agent] = await db.insert(agents).values({
    name: NATIVE_REVIEWER_AGENT_NAME,
    tokenHash: await hashToken(randomToken(12)),
    isSystem: true,
    associatedUserId: null,
    gitAuthorName: "ClawHub Reviewer",
    gitAuthorEmail: "reviewer@agents.useclawhub.com",
    capabilities: { push: false, review: true },
  }).returning();
  const token = signToken({ kind: "agent", agentId: agent.id, name: agent.name });
  await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, agent.id));
  log("info", "native_reviewer_agent_created", { agentId: agent.id });
  return { agentId: agent.id, token };
}

/**
 * Lazily provision the per-repo native-reviewer standing agent (idempotent). It's
 * a review-mode, event-triggered (change.opened), keySource='platform', isSystem
 * standing agent sealing the system agent's token. Grants the system agent
 * `reviewer` on the repo. Returns the standing agent row.
 */
export async function ensureNativeReviewerForRepo(db: DB, repoId: string): Promise<typeof standingAgents.$inferSelect> {
  const found = (await db.select().from(standingAgents)
    .where(and(eq(standingAgents.repoId, repoId), eq(standingAgents.name, NATIVE_REVIEWER_STANDING_NAME))).limit(1))[0];
  const { agentId, token } = await ensureNativeReviewerAgent(db);
  const sealed = seal(token);
  await db.insert(repoCollaborators).values({ repoId, agentId, role: "reviewer" }).onConflictDoNothing();
  // The platform provider decides the protocol the reviewer's container speaks:
  // OpenRouter (D8) ⇒ OpenAI-shaped CLI (codex) through the /openai gateway; the
  // default Anthropic ⇒ claude through the /anthropic gateway.
  const openRouter = platformProvider() === "openrouter";
  const llmProvider = openRouter ? "openai" : "anthropic";
  const cli = openRouter ? "codex" : "claude";
  if (found) {
    // Refresh the sealed token (the boot re-issue rotated it) AND reconcile the
    // provider/cli so flipping CLAWHUB_PLATFORM_PROVIDER takes effect on next run.
    await db.update(standingAgents).set({ tokenCiphertext: sealed.ciphertext, tokenNonce: sealed.nonce, llmProvider, cli }).where(eq(standingAgents.id, found.id));
    return { ...found, tokenCiphertext: sealed.ciphertext, tokenNonce: sealed.nonce, llmProvider, cli };
  }
  const [row] = await db.insert(standingAgents).values({
    repoId, agentId, name: NATIVE_REVIEWER_STANDING_NAME,
    image: DEFAULT_HARNESS_IMAGE,
    trigger: "event", event: "change.opened", mode: "review",
    task: "Review this Change: read the diff and the Change intent, and post an advisory verdict with an intent-vs-diff summary and up to five specific additional-focus decisions. Ignore generated/vendored/lockfile files (review only human-authored changes). Do not execute repo code.",
    llmProvider, cli,
    keySource: "platform", isSystem: true,
    tokenCiphertext: sealed.ciphertext, tokenNonce: sealed.nonce,
    egressPolicy: "none", egressAllowedHosts: [],
    intervalSec: 3600, memoryMb: 1024, cpus: 1, timeoutSec: 900,
  }).returning();
  log("info", "native_reviewer_repo_provisioned", { repoId, standingId: row.id });
  metrics.inc("clawhub_native_reviewer_provisioned_total", {});
  return row;
}

/** Master flag: platform-wide enable for the native reviewer. */
export function nativeReviewerMasterFlag(): boolean {
  return process.env.CLAWHUB_NATIVE_REVIEWER_ENABLED === "1" || process.env.CLAWHUB_NATIVE_REVIEWER_ENABLED === "true";
}

/**
 * Orchestrate a native review for a just-published Change: gate, lazily provision,
 * pick the model, dispatch through the standing-agent spine (review-only, gateway-
 * keyed). Best-effort — never throws into the caller's event handler.
 */
export async function maybeDispatchNativeReview(db: DB, events: EventBus, change: Pick<Change, "id" | "repoId" | "headCommit" | "isDraft" | "risk" | "computedRisk" | "changedPaths" | "openedByAgentId" | "openedByUserId">): Promise<boolean> {
  try {
    const repo = (await db.select({ nativeReviewerEnabled: repositories.nativeReviewerEnabled }).from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) return false;
    const repoFlag = repo.nativeReviewerEnabled ?? null;
    const gateBase = { masterFlag: nativeReviewerMasterFlag(), repoFlag, isDraft: change.isDraft };
    // Cheap pre-gate: draft / opt-out / master-off resolve from the flags alone, so
    // don't pay the BYO + daily-cap queries for the common "feature off" states —
    // this fires on EVERY published Change. Optimistic expensive inputs here: a
    // no-dispatch can only be the flag reasons, a dispatch means "worth looking up".
    const pre = nativeReviewerDecision({ ...gateBase, hasByoReviewer: false, dailyCapReached: false });
    if (!pre.dispatch) {
      metrics.inc("clawhub_native_reviewer_decision_total", { reason: pre.reason });
      return false;
    }
    // BYO auto-suppress: only a BYO mode=review agent suppresses (not verify) — and
    // force-on (repoFlag===true) ignores it, so skip the lookup entirely then.
    const byo = repoFlag === true ? undefined : (await db.select({ id: standingAgents.id }).from(standingAgents).where(and(
      eq(standingAgents.repoId, change.repoId), eq(standingAgents.mode, "review"),
      eq(standingAgents.enabled, true), eq(standingAgents.isSystem, false),
    )).limit(1))[0];
    const dailyCapReached = await globalDailyCapReached(db);
    const decision = nativeReviewerDecision({ ...gateBase, hasByoReviewer: !!byo, dailyCapReached });
    metrics.inc("clawhub_native_reviewer_decision_total", { reason: decision.reason });
    if (!decision.dispatch) return false;

    // D10 dispatch firewall: the atomic per-tenant gate (global ceiling → per-commit
    // dedup → $ budget → free token/repo caps → atomic review-count reserve). A deny
    // stops the platform reviewer (the tenant's own BYO reviewer, if any, still runs);
    // a `skip` means this exact head was already reviewed. Best-effort — a lookup
    // failure never blocks review. On proceed a review slot + dedup claim are HELD and
    // must be refunded if the dispatch enqueue then fails.
    const tenant = await tenantForRepo(db, change.repoId);
    let plan;
    let repoAdded = false;
    try {
      plan = await planFor(db, { orgId: tenant.orgId, userId: tenant.userId });
      const auth = await authorizePlatformReview(db, { tenant, plan, repoId: change.repoId, changeId: change.id, headCommit: change.headCommit, agentOrigin: !!change.openedByAgentId });
      if (auth.mode !== "proceed") {
        metrics.inc("clawhub_native_reviewer_decision_total", { reason: auth.reason });
        return false;
      }
      repoAdded = !!auth.repoAdded;
    } catch (e) {
      // FAIL CLOSED: an un-evaluable spend-cap gate must NOT dispatch a metered
      // platform review. The old code logged + fell through, so a transient DB /
      // Redis error on the quota path silently bypassed every cap (the exact hole
      // the D10 firewall exists to close). Skip the dispatch instead.
      log("warn", "native_reviewer_budget_check_failed", { changeId: change.id, err: (e as Error).message });
      metrics.inc("clawhub_native_reviewer_decision_total", { reason: "budget_check_error" });
      return false;
    }

    const changedPaths = Array.isArray(change.changedPaths) ? (change.changedPaths as unknown[]).filter((p): p is string => typeof p === "string") : [];
    const effectiveRisk = (RANK[(change.computedRisk as Risk) ?? "low"] >= RANK[change.risk as Risk] ? (change.computedRisk as Risk) : change.risk as Risk) ?? "low";
    const authorRollbacks = await countAuthorRollbacks(db, change);
    const sel = selectReviewModel({ effectiveRisk, changedPaths, authorRollbacks, changeId: change.id, headCommit: change.headCommit });

    const sa = await ensureNativeReviewerForRepo(db, change.repoId);
    // Map the risk-router decision to the concrete dispatch model. Anthropic passes
    // the alias straight to claude --model (haiku/sonnet); OpenRouter (D8/D9) maps it
    // through the capability tier (fast/balanced/frontier) to the qualified open-model
    // slug the gateway will US-pin.
    const dispatchModel = platformProvider() === "openrouter"
      ? platformModelForTier(reviewTier(sel.model, sel.audited))
      : sel.model;
    const r = await dispatchStandingRun(db, events, sa, { commit: change.headCommit, changeId: change.id, model: dispatchModel });
    if (r.ok) metrics.inc("clawhub_native_reviewer_dispatched_total", { tier: sel.model, audited: String(sel.audited) });
    // The dispatch enqueue failed after we reserved a slot → refund the count slot +
    // release the per-commit claim + release a newly-added repo slot so a transient
    // failure permanently consumes nothing.
    else await refundPlatformReview(tenant, change.id, change.headCommit, repoAdded, change.repoId).catch(() => {});
    return r.ok;
  } catch (e) {
    log("warn", "native_reviewer_dispatch_failed", { changeId: change.id, err: (e as Error).message });
    return false;
  }
}

// ── Contract enforcement (native-review-v1) ────────────────────────────────
// A system reviewer's payload is schema-enforced at POST /reviews: verdict +
// an intent_vs_diff summary (≤2000 chars) + ≤5 additionalFocus decisions. We
// REJECT (never truncate) on violation so a malformed/oversized model output
// can't silently land. `contract` is persisted verbatim for the advisory card.

export const NATIVE_REVIEW_CONTRACT_VERSION = "native-review-v1";
const INTENT_VS_DIFF_MAX = 2000;
const MAX_ADDITIONAL_FOCUS = 5;

export interface NativeReviewContract {
  version: typeof NATIVE_REVIEW_CONTRACT_VERSION;
  verdict: "approve" | "request_changes" | "comment";
  intentVsDiff: string;
  additionalFocus: Array<{ path: string; startLine: number; endLine: number; reason: string }>;
  /** The model that produced this review, if the reviewer reported it (for the badge). */
  model?: string;
}

export function validateNativeReviewContract(body: {
  verdict?: string;
  summary?: string;
  model?: string;
  additionalFocus?: Array<{ path?: string; startLine?: number; endLine?: number; note?: string; reason?: string }>;
}): { ok: true; contract: NativeReviewContract } | { ok: false; error: string } {
  if (!body.verdict || !["approve", "request_changes", "comment"].includes(body.verdict)) return { ok: false, error: "verdict must be approve|request_changes|comment" };
  const intentVsDiff = (body.summary ?? "").trim();
  if (!intentVsDiff) return { ok: false, error: "summary (intent_vs_diff) is required" };
  if (intentVsDiff.length > INTENT_VS_DIFF_MAX) return { ok: false, error: `summary exceeds ${INTENT_VS_DIFF_MAX} chars` };
  const focusIn = Array.isArray(body.additionalFocus) ? body.additionalFocus : [];
  if (focusIn.length > MAX_ADDITIONAL_FOCUS) return { ok: false, error: `at most ${MAX_ADDITIONAL_FOCUS} additionalFocus items` };
  const additionalFocus: NativeReviewContract["additionalFocus"] = [];
  for (const f of focusIn) {
    if (typeof f.path !== "string" || !f.path) return { ok: false, error: "each additionalFocus needs a path" };
    if (!Number.isFinite(f.startLine) || !Number.isFinite(f.endLine)) return { ok: false, error: "each additionalFocus needs numeric startLine/endLine" };
    const reason = (f.reason ?? f.note ?? "").toString().trim();
    if (!reason) return { ok: false, error: "each additionalFocus needs a reason" };
    if (reason.length > 500) return { ok: false, error: "additionalFocus reason exceeds 500 chars" };
    additionalFocus.push({ path: f.path, startLine: f.startLine as number, endLine: f.endLine as number, reason });
  }
  const model = typeof body.model === "string" ? body.model.slice(0, 64) : undefined;
  return { ok: true, contract: { version: NATIVE_REVIEW_CONTRACT_VERSION, verdict: body.verdict as NativeReviewContract["verdict"], intentVsDiff, additionalFocus, ...(model ? { model } : {}) } };
}

/** Is this reviewer a ClawHub system agent (→ advisory + contract-enforced)? */
export async function isSystemReviewer(db: DB, reviewerKind: string, reviewerId: string): Promise<boolean> {
  if (reviewerKind !== "agent") return false;
  const a = (await db.select({ isSystem: agents.isSystem }).from(agents).where(eq(agents.id, reviewerId)).limit(1))[0];
  return !!a?.isSystem;
}

async function countAuthorRollbacks(db: DB, change: Pick<Change, "repoId" | "openedByAgentId" | "openedByUserId">): Promise<number> {
  const rows = await db.select({ id: changes.id }).from(changes).where(and(
    eq(changes.repoId, change.repoId),
    change.openedByAgentId ? eq(changes.openedByAgentId, change.openedByAgentId) : change.openedByUserId ? eq(changes.openedByUserId, change.openedByUserId) : eq(changes.repoId, "00000000-0000-0000-0000-000000000000"),
    eq(changes.status, "rolled_back"),
  ));
  return rows.length;
}

async function globalDailyCapReached(db: DB): Promise<boolean> {
  // Authoritative backstop until the M7 per-tenant budgets land: count actual
  // native-reviewer runs dispatched in the last 24h across the platform.
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const saIds = (await db.select({ id: standingAgents.id }).from(standingAgents).where(eq(standingAgents.name, NATIVE_REVIEWER_STANDING_NAME))).map(r => r.id);
  if (!saIds.length) return false;
  const runs = await db.select({ id: ciRuns.id }).from(ciRuns).where(and(
    inArray(ciRuns.standingAgentId, saIds), gte(ciRuns.createdAt, since),
  ));
  return runs.length >= GLOBAL_DAILY_CAP;
}
