import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { EventBus } from "./events.js";
import { agents, repoCollaborators, repositories, standingAgents } from "../models/schema.js";
import type { Change } from "../models/schema.js";
import { hashToken, randomToken, signToken } from "./auth.js";
import { seal } from "./secrets.js";
import { DEFAULT_HARNESS_IMAGE, dispatchStandingRun } from "./standing-agents.js";
import { platformProvider, platformModelForTier } from "./llm-catalog.js";
import { authorizePlatformVerify, refundPlatformVerify, tenantForRepo } from "./platform-billing.js";
import { planFor } from "./entitlements.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";

// Platform-keyed VERIFY (D10 economics: verify_credits + $2 SKU). A ClawHub-owned
// SYSTEM verify agent runs the e2e verifier on a published Change through the same
// change.opened spine as the native reviewer — but verify is HEAVY (clone + boot +
// 30–80-call browse), metered at $2, and gated hard: OFF unless the repo (or its
// Loop) opts in, PAID plans only (free = 0 verify), within the verify-credit pool +
// $ budget + the global ceiling. Its attestation feeds verified autonomy exactly
// like a BYO verifier — the only difference is who holds the key. keySource='platform'
// stays a SYSTEM-agent privilege (D2), so this is a system agent, never a user role.

export const NATIVE_VERIFIER_AGENT_NAME = "clawhub-native-verifier";
export const NATIVE_VERIFIER_STANDING_NAME = "clawhub-native-verifier";

/** Master flag: platform verify is enabled platform-wide (paired with the repo opt-in). */
export function platformVerifyMasterFlag(): boolean {
  return process.env.CLAWHUB_PLATFORM_VERIFY_ENABLED === "1" || process.env.CLAWHUB_PLATFORM_VERIFY_ENABLED === "true";
}

/** Find-or-create the single ClawHub-owned system verifier agent. Returns its token. */
export async function ensureNativeVerifierAgent(db: DB): Promise<{ agentId: string; token: string }> {
  const existing = (await db.select().from(agents).where(eq(agents.name, NATIVE_VERIFIER_AGENT_NAME)).limit(1))[0];
  if (existing) {
    const token = signToken({ kind: "agent", agentId: existing.id, name: existing.name });
    await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, existing.id));
    return { agentId: existing.id, token };
  }
  const [agent] = await db.insert(agents).values({
    name: NATIVE_VERIFIER_AGENT_NAME,
    tokenHash: await hashToken(randomToken(12)),
    isSystem: true,
    associatedUserId: null,
    gitAuthorName: "ClawHub Verifier",
    gitAuthorEmail: "verifier@agents.useclawhub.com",
    capabilities: { push: false, review: true },
  }).returning();
  const token = signToken({ kind: "agent", agentId: agent.id, name: agent.name });
  await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, agent.id));
  log("info", "native_verifier_agent_created", { agentId: agent.id });
  return { agentId: agent.id, token };
}

/**
 * Lazily provision the per-repo native-verifier standing agent (idempotent). A verify-
 * mode, event-triggered (change.opened), keySource='platform', isSystem standing agent.
 * Unlike the review-only reviewer it CLONES + runs the app (egress 'none' still lets it
 * reach the localhost app it boots + the LLM gateway), with more memory + a long timeout.
 */
export async function ensureNativeVerifierForRepo(db: DB, repoId: string): Promise<typeof standingAgents.$inferSelect> {
  const found = (await db.select().from(standingAgents)
    .where(and(eq(standingAgents.repoId, repoId), eq(standingAgents.name, NATIVE_VERIFIER_STANDING_NAME))).limit(1))[0];
  const { agentId, token } = await ensureNativeVerifierAgent(db);
  const sealed = seal(token);
  await db.insert(repoCollaborators).values({ repoId, agentId, role: "reviewer" }).onConflictDoNothing();
  const openRouter = platformProvider() === "openrouter";
  const llmProvider = openRouter ? "openai" : "anthropic";
  const cli = openRouter ? "codex" : "claude";
  if (found) {
    await db.update(standingAgents).set({ tokenCiphertext: sealed.ciphertext, tokenNonce: sealed.nonce, llmProvider, cli }).where(eq(standingAgents.id, found.id));
    return { ...found, tokenCiphertext: sealed.ciphertext, tokenNonce: sealed.nonce, llmProvider, cli };
  }
  const [row] = await db.insert(standingAgents).values({
    repoId, agentId, name: NATIVE_VERIFIER_STANDING_NAME,
    image: DEFAULT_HARNESS_IMAGE,
    trigger: "event", event: "change.opened", mode: "verify",
    task: "Verify this Change end-to-end: boot the app, drive the changed surface in a real browser against the behavior spec, and post a verification attestation with per-check evidence. Do not merge.",
    llmProvider, cli,
    keySource: "platform", isSystem: true,
    tokenCiphertext: sealed.ciphertext, tokenNonce: sealed.nonce,
    egressPolicy: "none", egressAllowedHosts: [],
    intervalSec: 3600, memoryMb: 2048, cpus: 2, timeoutSec: 1800,
  }).returning();
  log("info", "native_verifier_repo_provisioned", { repoId, standingId: row.id });
  metrics.inc("clawhub_native_verifier_provisioned_total", {});
  return row;
}

/** Is platform verify enabled for this repo? Repo tri-state overrides the master flag:
 *  true = on, false = off, null = follow the master flag (default OFF for verify). */
export function platformVerifyEnabledFor(repoFlag: boolean | null): boolean {
  if (repoFlag === true) return true;
  if (repoFlag === false) return false;
  return false; // verify is opt-in; the master flag alone does not turn it on per-repo
}

/**
 * Orchestrate a platform verify for a just-published Change: gate (repo opt-in + paid
 * plan + verify-credit pool + $ budget + global ceiling), provision, dispatch a head-
 * pinned verify run on the balanced tier, metered as verify_run. Best-effort.
 */
export async function maybeDispatchNativeVerify(db: DB, events: EventBus, change: Pick<Change, "id" | "repoId" | "headCommit" | "isDraft">): Promise<boolean> {
  try {
    if (change.isDraft) return false;
    const repo = (await db.select({ platformVerifyEnabled: repositories.platformVerifyEnabled }).from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo || !platformVerifyEnabledFor(repo.platformVerifyEnabled ?? null)) return false;
    // Master kill switch is a HARD global gate: off ⇒ no platform verify anywhere,
    // regardless of a repo opt-in. The old `&& repo.platformVerifyEnabled !== true`
    // let a repo opt-in bypass the switch, making CLAWHUB_PLATFORM_VERIFY_ENABLED
    // dead code — a metered $2 run could not be killed platform-wide.
    if (!platformVerifyMasterFlag()) return false;

    const tenant = await tenantForRepo(db, change.repoId);
    const plan = await planFor(db, { orgId: tenant.orgId, userId: tenant.userId });
    const auth = await authorizePlatformVerify(db, { tenant, plan, changeId: change.id, headCommit: change.headCommit });
    if (auth.mode !== "proceed") {
      metrics.inc("clawhub_native_verifier_decision_total", { reason: auth.reason });
      return false;
    }

    const sa = await ensureNativeVerifierForRepo(db, change.repoId);
    // Verify always runs on the BALANCED tier (the agentic verify workhorse).
    const model = platformProvider() === "openrouter" ? platformModelForTier("balanced") : "sonnet";
    const r = await dispatchStandingRun(db, events, sa, { commit: change.headCommit, changeId: change.id, model });
    if (r.ok) metrics.inc("clawhub_native_verifier_dispatched_total", {});
    // Enqueue failed after we claimed the head → release the dedup claim so a retry can run.
    else await refundPlatformVerify(change.id, change.headCommit).catch(() => {});
    return r.ok;
  } catch (e) {
    log("warn", "native_verifier_dispatch_failed", { changeId: change.id, err: (e as Error).message });
    return false;
  }
}
