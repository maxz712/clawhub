import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, ciRuns, repoCollaborators, standingAgents } from "../models/schema.js";
import type { StandingAgent } from "../models/schema.js";
import type { EventBus } from "./events.js";
import { seal, unseal } from "./secrets.js";
import { hashToken, matchesHash, randomToken, signToken, verifyToken } from "./auth.js";
import { resolveRepoTarget } from "./ci-trigger.js";
import { isAgentKilled } from "./kill-switch.js";
import { checkAgentBudget } from "./cost-ledger.js";
import { log } from "./logger.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";

// A standing agent is a BYO container image ClawHub runs continuously / on a
// schedule / on events, scoped to one repo, acting as a ClawHub agent. ClawHub
// never runs the model — the container does, with the sealed LLM key injected at
// run time. A tick dispatches as a ci_runs row (origin='agent', pipelineId null)
// reusing the runner + the per-run-token secrets endpoint. See
// docs/standing-agents.md.
//
// TRUST MODEL: a standing run holds a per-run runnerToken exactly like a CI run —
// no new privilege, and it never merges. Its pushes open Changes that flow through
// the normal human-gated merge policy. Dispatch is bounded by (1) one run in
// flight per agent, (2) a per-agent rate cap, and (3) the kill switch + cost
// budget — checked on every tick.

export const STANDING_RATE_CAP = Number(process.env.CLAWHUB_STANDING_RATE_CAP ?? 30);
export const STANDING_RATE_WINDOW_MS = 10 * 60_000;
/** Continuous-trigger interval floor — a misconfigured tiny interval can't hot-loop. */
export const MIN_INTERVAL_SEC = 60;

export const VALID_TRIGGERS = ["manual", "continuous", "schedule", "event"] as const;
export const VALID_PROVIDERS = ["anthropic", "openrouter", "openai", "custom"] as const;
export type StandingTrigger = (typeof VALID_TRIGGERS)[number];
export type LlmProvider = (typeof VALID_PROVIDERS)[number];

export interface CreateStandingInput {
  repoId: string;
  name: string;
  image: string;
  command?: string | null;
  trigger?: string;
  cron?: string | null;
  event?: string | null;
  intervalSec?: number;
  task?: string;
  llmProvider?: string;
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;
  memoryMb?: number;
  cpus?: number;
  timeoutSec?: number;
  // Identity — exactly one of:
  agentToken?: string;   // an existing agent's live JWT, sealed as-is (CLI path)
  agentName?: string;    // find-or-create a dedicated agent (dashboard path)
  createdByUserId: string;
}

export interface UpdateStandingInput {
  name?: string;
  image?: string;
  command?: string | null;
  trigger?: string;
  cron?: string | null;
  event?: string | null;
  intervalSec?: number;
  task?: string;
  llmProvider?: string;
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;   // when present, re-seal; when omitted, keep existing
  memoryMb?: number;
  cpus?: number;
  timeoutSec?: number;
  enabled?: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/i;

/** Validate trigger + provider config; throws ValidationError. Pure. */
export function validateStandingConfig(cfg: {
  trigger?: string; cron?: string | null; event?: string | null;
  intervalSec?: number; llmProvider?: string; image?: string; name?: string;
}): void {
  if (cfg.name !== undefined && !NAME_RE.test(cfg.name)) throw new ValidationError("bad name");
  if (cfg.image !== undefined && !cfg.image.trim()) throw new ValidationError("image required");
  if (cfg.trigger !== undefined) {
    if (!VALID_TRIGGERS.includes(cfg.trigger as StandingTrigger)) throw new ValidationError(`trigger must be one of ${VALID_TRIGGERS.join(", ")}`);
    if (cfg.trigger === "schedule" && !cfg.cron?.trim()) throw new ValidationError("trigger schedule requires a `cron` 5-field expression");
    if (cfg.trigger === "event" && !cfg.event?.trim()) throw new ValidationError("trigger event requires an `event` type");
  }
  if (cfg.intervalSec !== undefined && (!Number.isFinite(cfg.intervalSec) || cfg.intervalSec < MIN_INTERVAL_SEC)) {
    throw new ValidationError(`intervalSec must be >= ${MIN_INTERVAL_SEC}`);
  }
  if (cfg.llmProvider !== undefined && !VALID_PROVIDERS.includes(cfg.llmProvider as LlmProvider)) {
    throw new ValidationError(`llmProvider must be one of ${VALID_PROVIDERS.join(", ")}`);
  }
}

/**
 * Build the LLM environment a container receives, mapping the generic provider
 * config onto the conventional per-provider env vars plus a generic mirror. Pure
 * and exported so the var-mapping is unit-testable without a DB. A null/empty key
 * means "no key injected" (e.g. a local no-auth model, or keys via repo secrets).
 */
export function standingLlmEnv(provider: string, baseUrl: string | null | undefined, key: string | null | undefined): Record<string, string> {
  const env: Record<string, string> = { LLM_PROVIDER: provider };
  const k = key ?? "";
  if (k) env.LLM_API_KEY = k;
  if (provider === "anthropic") {
    if (k) env.ANTHROPIC_API_KEY = k;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  } else if (provider === "openrouter") {
    if (k) env.OPENROUTER_API_KEY = k;
    env.LLM_BASE_URL = baseUrl || "https://openrouter.ai/api/v1";
  } else if (provider === "openai") {
    if (k) env.OPENAI_API_KEY = k;
    if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
  }
  if (baseUrl && !env.LLM_BASE_URL) env.LLM_BASE_URL = baseUrl;
  return env;
}

/**
 * The full env injected into a standing-agent container: ClawHub context + the
 * agent push token + the LLM creds. Pure (takes already-unsealed secrets) so the
 * shape is unit-testable. The runner merges this over process.env and repo
 * secrets and passes each as a `-e` to `docker run`.
 */
export function buildStandingEnv(args: {
  sa: Pick<StandingAgent, "id" | "llmProvider" | "llmBaseUrl" | "task">;
  clawhubUrl: string;
  repo: string;          // "<ns>/<repo>"
  commit: string;
  token: string;         // unsealed agent JWT
  llmKey: string | null; // unsealed LLM key
}): Record<string, string> {
  return {
    CLAWHUB_URL: args.clawhubUrl,
    CLAWHUB_TOKEN: args.token,
    CLAWHUB_REPO: args.repo,
    CLAWHUB_COMMIT: args.commit,
    CLAWHUB_TASK: args.sa.task ?? "",
    CLAWHUB_STANDING_AGENT_ID: args.sa.id,
    ...standingLlmEnv(args.sa.llmProvider, args.sa.llmBaseUrl, args.llmKey),
  };
}

/** Pure: is an agent under its per-agent dispatch rate cap given its recent run count? */
export function withinStandingRateCap(recentCount: number): boolean {
  return recentCount < STANDING_RATE_CAP;
}

/** Pure: is a continuous agent due to tick? (never-run → due; else interval elapsed). */
export function continuousDue(lastRunAt: Date | null, intervalSec: number, now: Date): boolean {
  return now.getTime() - (lastRunAt?.getTime() ?? 0) >= intervalSec * 1000;
}

/** Resolve the acting agent + seal its push token. Returns { agentId, sealed }. */
async function resolveIdentity(db: DB, input: CreateStandingInput): Promise<{ agentId: string; ciphertext: string; nonce: string }> {
  if (input.agentToken) {
    let payload: ReturnType<typeof verifyToken>;
    try { payload = verifyToken(input.agentToken); }
    catch { throw new ValidationError("agentToken is not a valid token"); }
    if (payload.kind !== "agent") throw new ValidationError("agentToken must be an agent token");
    const agent = (await db.select().from(agents).where(eq(agents.id, payload.agentId)).limit(1))[0];
    if (!agent) throw new NotFoundError("agent");
    // Must be the agent's LIVE token — a rotated/stale token would auth-fail at run
    // time, so reject it at attach time with a clear message instead.
    if (!(await matchesHash(input.agentToken, agent.tokenHash))) throw new ValidationError("agentToken is not the agent's current token (rotate, then re-attach)");
    const s = seal(input.agentToken);
    return { agentId: agent.id, ciphertext: s.ciphertext, nonce: s.nonce };
  }
  if (input.agentName) {
    if (!NAME_RE.test(input.agentName)) throw new ValidationError("bad agentName");
    const existing = (await db.select().from(agents).where(eq(agents.name, input.agentName)).limit(1))[0];
    if (existing) {
      // Only the owner may repurpose an existing agent as a standing worker, and
      // doing so ROTATES its token (sealing the new one) — surface that the old
      // token is now dead.
      if (existing.associatedUserId !== input.createdByUserId) throw new ForbiddenError("agent exists and is not yours; pass a fresh agentName or its agentToken");
      const token = signToken({ kind: "agent", agentId: existing.id, name: existing.name });
      await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, existing.id));
      const s = seal(token);
      return { agentId: existing.id, ciphertext: s.ciphertext, nonce: s.nonce };
    }
    // Create a fresh dedicated agent, claimed to the caller so it shows in their
    // dashboard. Mirrors routes/agents.ts: placeholder hash → sign with real id.
    const inserted = (await db.insert(agents).values({
      name: input.agentName,
      tokenHash: await hashToken(randomToken(12)),
      associatedUserId: input.createdByUserId,
      gitAuthorName: input.agentName,
      gitAuthorEmail: `${input.agentName}@agents.useclawhub.com`,
      capabilities: { push: true, review: true },
    }).returning())[0];
    const token = signToken({ kind: "agent", agentId: inserted.id, name: inserted.name });
    await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, inserted.id));
    const s = seal(token);
    return { agentId: inserted.id, ciphertext: s.ciphertext, nonce: s.nonce };
  }
  throw new ValidationError("one of agentToken or agentName is required");
}

/** Strip secrets/internal columns from a row before returning over the API. */
export function redactStanding(sa: StandingAgent) {
  const { tokenCiphertext, tokenNonce, llmCiphertext, llmNonce, ...rest } = sa;
  return { ...rest, hasLlmKey: !!llmCiphertext };
}

export async function createStandingAgent(db: DB, input: CreateStandingInput): Promise<StandingAgent> {
  validateStandingConfig(input);
  const trigger = (input.trigger ?? "manual") as StandingTrigger;
  const provider = (input.llmProvider ?? "anthropic") as LlmProvider;
  const { agentId, ciphertext, nonce } = await resolveIdentity(db, input);

  // Grant the acting agent push rights on the repo (idempotent).
  await db.insert(repoCollaborators).values({ repoId: input.repoId, agentId, role: "writer" }).onConflictDoNothing();

  const llmSeal = input.llmApiKey ? seal(input.llmApiKey) : null;
  const [row] = await db.insert(standingAgents).values({
    repoId: input.repoId,
    agentId,
    name: input.name,
    image: input.image,
    command: input.command ?? null,
    trigger,
    cron: input.cron ?? null,
    event: input.event ?? null,
    intervalSec: input.intervalSec ?? 300,
    task: input.task ?? "",
    llmProvider: provider,
    llmBaseUrl: input.llmBaseUrl ?? null,
    llmCiphertext: llmSeal?.ciphertext ?? null,
    llmNonce: llmSeal?.nonce ?? null,
    tokenCiphertext: ciphertext,
    tokenNonce: nonce,
    memoryMb: input.memoryMb ?? 1024,
    cpus: input.cpus ?? 1,
    timeoutSec: input.timeoutSec ?? 1800,
    createdByUserId: input.createdByUserId,
  }).returning();
  log("info", "standing_agent_created", { id: row.id, repoId: row.repoId, agentId, trigger });
  return row;
}

export async function listStandingAgents(db: DB, repoId: string): Promise<StandingAgent[]> {
  return db.select().from(standingAgents).where(eq(standingAgents.repoId, repoId)).orderBy(desc(standingAgents.createdAt));
}

export async function getStandingAgent(db: DB, repoId: string, id: string): Promise<StandingAgent> {
  const row = (await db.select().from(standingAgents).where(and(eq(standingAgents.id, id), eq(standingAgents.repoId, repoId))).limit(1))[0];
  if (!row) throw new NotFoundError("standing agent");
  return row;
}

export async function updateStandingAgent(db: DB, repoId: string, id: string, input: UpdateStandingInput): Promise<StandingAgent> {
  const existing = await getStandingAgent(db, repoId, id);
  // Validate against the merged result so a partial patch can't leave an
  // invalid trigger/cron/event combination.
  validateStandingConfig({
    trigger: input.trigger ?? existing.trigger,
    cron: input.cron !== undefined ? input.cron : existing.cron,
    event: input.event !== undefined ? input.event : existing.event,
    intervalSec: input.intervalSec ?? existing.intervalSec,
    llmProvider: input.llmProvider ?? existing.llmProvider,
    image: input.image ?? existing.image,
    name: input.name ?? existing.name,
  });
  const patch: Partial<typeof standingAgents.$inferInsert> = {};
  for (const k of ["name", "image", "command", "trigger", "cron", "event", "intervalSec", "task", "llmProvider", "llmBaseUrl", "memoryMb", "cpus", "timeoutSec", "enabled"] as const) {
    if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = input[k];
  }
  if (input.llmApiKey !== undefined) {
    if (input.llmApiKey) { const s = seal(input.llmApiKey); patch.llmCiphertext = s.ciphertext; patch.llmNonce = s.nonce; }
    else { patch.llmCiphertext = null; patch.llmNonce = null; }
  }
  // `status` is the run lifecycle (idle | running | error); "paused" is derived
  // from `enabled` in the UI. Re-enabling a previously errored agent clears the
  // sticky error so the next tick starts clean.
  if (input.enabled === true && existing.status === "error") { patch.status = "idle"; patch.lastError = null; }
  const [row] = await db.update(standingAgents).set(patch).where(eq(standingAgents.id, id)).returning();
  return row;
}

export async function deleteStandingAgent(db: DB, repoId: string, id: string): Promise<void> {
  await getStandingAgent(db, repoId, id); // 404 if not in this repo
  await db.delete(standingAgents).where(eq(standingAgents.id, id));
}

/** Number of this standing agent's runs in the rate window. */
async function recentRunCount(db: DB, standingAgentId: string): Promise<number> {
  const since = new Date(Date.now() - STANDING_RATE_WINDOW_MS);
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(ciRuns)
    .where(and(eq(ciRuns.standingAgentId, standingAgentId), gte(ciRuns.createdAt, since)));
  return Number(r?.n ?? 0);
}

/** Is a run for this standing agent currently pending or running? */
async function hasRunInFlight(db: DB, standingAgentId: string): Promise<boolean> {
  const live = await db.select({ id: ciRuns.id }).from(ciRuns)
    .where(and(eq(ciRuns.standingAgentId, standingAgentId), inArray(ciRuns.status, ["pending", "running"]))).limit(1);
  return live.length > 0;
}

export type DispatchResult =
  | { ok: true; runId: string }
  | { ok: false; reason: "disabled" | "killed" | "over_budget" | "in_flight" | "rate_capped" | "unresolved" };

/**
 * Dispatch one standing-agent tick: governance-check, then create a ci_runs row
 * (origin='agent', pipelineId null) at the repo default-branch HEAD and publish
 * ci.run.queued so the runner picks it up. The image/command live on the standing
 * agent row; the runner reads them from the secrets endpoint (gated by the per-run
 * token). The sealed agent token + LLM key are NEVER in the published event.
 */
export async function dispatchStandingRun(
  db: DB,
  events: EventBus,
  sa: StandingAgent,
  opts: { manual?: boolean } = {},
): Promise<DispatchResult> {
  if (!sa.enabled && !opts.manual) return { ok: false, reason: "disabled" };

  if (await isAgentKilled(db, sa.agentId)) {
    await markStatus(db, sa.id, "error", "agent kill switch engaged");
    return { ok: false, reason: "killed" };
  }
  const budget = await checkAgentBudget(db, sa.agentId);
  if (!budget.ok) {
    await markStatus(db, sa.id, "error", `cost budget exceeded (${budget.spentCents}/${budget.limitCents} cents)`);
    return { ok: false, reason: "over_budget" };
  }
  // One run in flight per agent: continuous/event ticks can't stack.
  if (await hasRunInFlight(db, sa.id)) return { ok: false, reason: "in_flight" };
  // Per-agent backstop: bounds ANY loop shape (tiny interval, event self-trigger,
  // manual spam) independent of how it forms.
  if (!withinStandingRateCap(await recentRunCount(db, sa.id))) {
    log("warn", "standing_rate_capped", { id: sa.id, cap: STANDING_RATE_CAP });
    await markStatus(db, sa.id, "error", `rate cap reached (${STANDING_RATE_CAP}/${STANDING_RATE_WINDOW_MS / 60000}m)`);
    return { ok: false, reason: "rate_capped" };
  }

  const target = await resolveRepoTarget(db, sa.repoId);
  if (!target) {
    log("warn", "standing_target_unresolved", { id: sa.id, repoId: sa.repoId });
    return { ok: false, reason: "unresolved" };
  }

  const runnerToken = randomToken(18);
  const [run] = await db.insert(ciRuns).values({
    repoId: sa.repoId,
    standingAgentId: sa.id,
    runnerToken,
    origin: "agent",
    commit: target.commit,
    // pipelineId + changeId stay null: a standing run has neither.
  }).returning();

  await db.update(standingAgents).set({ status: "running", lastRunId: run.id, lastRunAt: new Date(), lastError: null }).where(eq(standingAgents.id, sa.id));

  await events.publish({
    type: "ci.run.queued",
    repoId: sa.repoId,
    actorKind: "system",
    actorId: "standing-agent",
    // Non-secret payload only. image/command let the runner choose the container
    // branch; the agent token + LLM key come from the gated secrets endpoint.
    payload: {
      runId: run.id, repoNs: target.ns, repoName: target.repoName, commit: target.commit,
      runnerToken, standing: true, image: sa.image, command: sa.command ?? undefined,
      timeoutSec: sa.timeoutSec, memoryMb: sa.memoryMb, cpus: sa.cpus,
    },
  });
  log("info", "standing_run_queued", { id: sa.id, runId: run.id, commit: target.commit });
  return { ok: true, runId: run.id };
}

async function markStatus(db: DB, id: string, status: string, lastError?: string): Promise<void> {
  await db.update(standingAgents).set({ status, lastError: lastError ?? null }).where(eq(standingAgents.id, id));
}

/**
 * Resolve the sealed env for a standing run, for the gated secrets endpoint.
 * Returns null if the run isn't a standing run (caller falls back to repo
 * secrets). Unseals the agent token + LLM key here, never anywhere reachable
 * without the per-run runnerToken.
 */
export async function standingRunEnv(db: DB, run: { standingAgentId: string | null; commit: string | null; repoId: string }, clawhubUrl: string): Promise<Record<string, string> | null> {
  if (!run.standingAgentId) return null;
  const sa = (await db.select().from(standingAgents).where(eq(standingAgents.id, run.standingAgentId)).limit(1))[0];
  if (!sa) return null;
  const target = await resolveRepoTarget(db, sa.repoId);
  const repo = target ? `${target.ns}/${target.repoName}` : "";
  let token = "";
  try { token = unseal(sa.tokenCiphertext, sa.tokenNonce); } catch { /* sealing key changed; token unrecoverable */ }
  let llmKey: string | null = null;
  if (sa.llmCiphertext && sa.llmNonce) { try { llmKey = unseal(sa.llmCiphertext, sa.llmNonce); } catch { llmKey = null; } }
  return buildStandingEnv({
    sa,
    clawhubUrl,
    repo,
    commit: run.commit ?? target?.commit ?? "",
    token,
    llmKey,
  });
}
