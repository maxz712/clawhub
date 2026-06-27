import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, ciRuns, repoCollaborators, repositories, standingAgents } from "../models/schema.js";
import type { StandingAgent } from "../models/schema.js";
import type { EventBus } from "./events.js";
import { seal, unseal } from "./secrets.js";
import { hashToken, matchesHash, randomToken, signToken, verifyToken } from "./auth.js";
import { resolveRepoTarget } from "./ci-trigger.js";
import { isAgentKilled } from "./kill-switch.js";
import { checkAgentBudget, checkOrgBudget } from "./cost-ledger.js";
import { withChangeUpsertLock } from "./repo-lock.js";
import { parseCron } from "./cron.js";
import { buildMemoryPack, resolveScopeIds } from "./memory.js";
import { metrics } from "./metrics.js";
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
/** After this many consecutive failures the circuit breaker auto-pauses the agent. */
export const STANDING_MAX_CONSECUTIVE_FAILURES = Number(process.env.CLAWHUB_STANDING_MAX_FAILURES ?? 5);
/**
 * Exponential-backoff exponent ceiling. Backoff is only computed for failure
 * counts BELOW the auto-pause ceiling, so under the default MAX=5 the largest hold
 * is intervalSec·2^4; this cap only binds when CLAWHUB_STANDING_MAX_FAILURES is
 * raised above 7, keeping the hold at intervalSec·2^6 regardless.
 */
export const STANDING_BACKOFF_CAP = 6;
/** A pending standing run never claimed within this window is re-published (at-least-once). */
export const STANDING_REPUBLISH_AFTER_MS = Number(process.env.CLAWHUB_STANDING_REPUBLISH_AFTER_MS ?? 120_000);

// The reference-harness image (Claude Code + Playwright/Chromium baked in). A
// standing agent attached without an explicit image defaults to this, so "bring
// your own AI" needs only an LLM key — not a container you built. Honors
// CLAWHUB_HARNESS_IMAGE, the same override the Role deployer uses; re-exported by
// services/agent-roles.ts so both paths share one source of truth.
export const DEFAULT_HARNESS_IMAGE = process.env.CLAWHUB_HARNESS_IMAGE ?? "ghcr.io/maxz712/clawhub-agent-harness:latest";

export const VALID_TRIGGERS = ["manual", "continuous", "schedule", "event"] as const;
export const VALID_PROVIDERS = ["anthropic", "openrouter", "openai", "custom"] as const;
export const VALID_EGRESS = ["none", "allowlist", "all"] as const;
// The coding-agent CLI the harness shells out to. Orthogonal to the LLM provider
// (the credential/backend): the harness reads CLAWHUB_CLI and runs that CLI, and
// the single sealed key is injected under whatever env var that CLI reads.
export const VALID_CLIS = ["claude", "copilot", "codex", "gemini"] as const;
export type StandingTrigger = (typeof VALID_TRIGGERS)[number];
export type LlmProvider = (typeof VALID_PROVIDERS)[number];
export type EgressPolicy = (typeof VALID_EGRESS)[number];
export type AgentCli = (typeof VALID_CLIS)[number];

// The credential env var(s) each CLI reads. One-step setup: the user picks a CLI
// + supplies one credential; ClawHub injects it under these. (Copilot CLI auths
// with a GitHub token; Gemini reads GEMINI_API_KEY; Codex reads OPENAI_API_KEY.)
export const CLI_KEY_ENVS: Record<AgentCli, string[]> = {
  claude: ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  copilot: ["GITHUB_TOKEN", "GH_TOKEN"],
};

const MAX_EGRESS_HOSTS = 100;
// host pattern: optional `*.`/`.` wildcard prefix, then dotted labels or a bare IP.
const EGRESS_HOST_RE = /^(\*\.|\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Normalize + validate an operator-supplied egress allowlist. Accepts an array or
 * a comma/whitespace-separated string, tolerates pasted URLs (keeps the host),
 * lowercases, dedupes, and rejects anything that isn't a plausible host pattern —
 * a bad entry must fail loudly, not silently widen or narrow what the agent can
 * reach. Pure + exported for tests.
 */
export function sanitizeEgressHosts(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(/[,\s]+/);
  const out: string[] = [];
  for (const item of raw) {
    let h = String(item ?? "").trim().toLowerCase();
    if (!h) continue;
    if (h.includes("://")) { try { h = new URL(h).hostname; } catch { throw new ValidationError(`bad egress host: ${item}`); } }
    h = h.replace(/:\d+$/, "").replace(/\/.*$/, "").replace(/^\[|\]$/g, ""); // strip port/path/ipv6 brackets
    if (!h) continue;
    if (h.length > 253 || !EGRESS_HOST_RE.test(h)) throw new ValidationError(`bad egress host: ${item}`);
    if (!out.includes(h)) out.push(h);
  }
  if (out.length > MAX_EGRESS_HOSTS) throw new ValidationError(`too many egress hosts (max ${MAX_EGRESS_HOSTS})`);
  return out;
}

export interface CreateStandingInput {
  repoId: string;
  name: string;
  image?: string;   // defaults to DEFAULT_HARNESS_IMAGE when omitted/blank
  command?: string | null;
  trigger?: string;
  cron?: string | null;
  event?: string | null;
  intervalSec?: number;
  mode?: string;
  task?: string;
  llmProvider?: string;
  cli?: string;   // claude | copilot | codex | gemini (default claude)
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;
  memoryMb?: number;
  cpus?: number;
  timeoutSec?: number;
  // Network containment for the BYO container (browser + LLM + push all egress
  // through here). none = infra-only; allowlist = infra + egressAllowedHosts; all
  // = any public host. Private/metadata ranges are blocked in every mode.
  egressPolicy?: string;
  egressAllowedHosts?: string[];
  // Identity — exactly one of:
  agentToken?: string;   // an existing agent's live JWT, sealed as-is (CLI path)
  agentName?: string;    // find-or-create a dedicated agent (dashboard path)
  // Required to repurpose an EXISTING agent via agentName — re-issuing its token
  // for the harness revokes whatever token it's using elsewhere, so it's opt-in.
  rotateToken?: boolean;
  // The Agent Role this standing agent was deployed from (set by the role deployer).
  roleId?: string | null;
  // Repo grant for the acting agent: "writer" (default) or "reviewer" (pure reviewer roles).
  grantRole?: "writer" | "reviewer";
  // Internal: when this agentToken belongs to the role's OWN dedicated agent (a role
  // deploy already authorized at the route), bypass the personal-ownership guard so
  // a co-admin can deploy a shared org role. NOT settable from request bodies.
  roleOwnedAgentId?: string;
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
  mode?: string;
  task?: string;
  llmProvider?: string;
  cli?: string;
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;   // when present, re-seal; when omitted, keep existing
  memoryMb?: number;
  cpus?: number;
  timeoutSec?: number;
  egressPolicy?: string;
  egressAllowedHosts?: string[];
  enabled?: boolean;
}

// Exported so callers that derive a standing-agent name (e.g. role deploy) can
// be tested against the exact constraint createStandingAgent enforces.
export const NAME_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/i;

// Upper bounds on operator-supplied container limits — these flow straight into
// `docker run`, so cap them so a typo can't pin a runner host.
const MAX_MEMORY_MB = 16384;   // 16 GB
const MAX_CPUS = 16;
const MAX_TIMEOUT_SEC = 6 * 3600; // 6h

/** Validate trigger + provider + resource config; throws ValidationError. Pure. */
export function validateStandingConfig(cfg: {
  trigger?: string; cron?: string | null; event?: string | null;
  intervalSec?: number; llmProvider?: string; cli?: string; image?: string; name?: string;
  memoryMb?: number; cpus?: number; timeoutSec?: number; egressPolicy?: string;
}): void {
  if (cfg.name !== undefined && !NAME_RE.test(cfg.name)) throw new ValidationError("bad name");
  if (cfg.image !== undefined && !cfg.image.trim()) throw new ValidationError("image required");
  if (cfg.trigger !== undefined) {
    if (!VALID_TRIGGERS.includes(cfg.trigger as StandingTrigger)) throw new ValidationError(`trigger must be one of ${VALID_TRIGGERS.join(", ")}`);
    if (cfg.trigger === "schedule") {
      if (!cfg.cron?.trim()) throw new ValidationError("trigger schedule requires a `cron` 5-field expression");
      // Reject an unparseable cron at config time, else the agent silently never
      // fires (mirrors routes/ci.ts PUT pipeline validation).
      try { parseCron(cfg.cron); } catch (e) { throw new ValidationError(`invalid cron: ${(e as Error).message}`); }
    }
    if (cfg.trigger === "event" && !cfg.event?.trim()) throw new ValidationError("trigger event requires an `event` type");
  }
  if (cfg.intervalSec !== undefined && (!Number.isFinite(cfg.intervalSec) || cfg.intervalSec < MIN_INTERVAL_SEC)) {
    throw new ValidationError(`intervalSec must be >= ${MIN_INTERVAL_SEC}`);
  }
  if (cfg.llmProvider !== undefined && !VALID_PROVIDERS.includes(cfg.llmProvider as LlmProvider)) {
    throw new ValidationError(`llmProvider must be one of ${VALID_PROVIDERS.join(", ")}`);
  }
  if (cfg.cli !== undefined && !VALID_CLIS.includes(cfg.cli as AgentCli)) {
    throw new ValidationError(`cli must be one of ${VALID_CLIS.join(", ")}`);
  }
  if (cfg.egressPolicy !== undefined && !VALID_EGRESS.includes(cfg.egressPolicy as EgressPolicy)) {
    throw new ValidationError(`egressPolicy must be one of ${VALID_EGRESS.join(", ")}`);
  }
  const bound = (v: number | undefined, name: string, max: number) => {
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > max)) throw new ValidationError(`${name} must be an integer in 1..${max}`);
  };
  bound(cfg.memoryMb, "memoryMb", MAX_MEMORY_MB);
  bound(cfg.cpus, "cpus", MAX_CPUS);
  bound(cfg.timeoutSec, "timeoutSec", MAX_TIMEOUT_SEC);
}

/**
 * Build the LLM environment a container receives, mapping the generic provider
 * config onto the conventional per-provider env vars plus a generic mirror. Pure
 * and exported so the var-mapping is unit-testable without a DB. A null/empty key
 * means "no key injected" (e.g. a local no-auth model, or keys via repo secrets).
 */
export function standingLlmEnv(provider: string, baseUrl: string | null | undefined, key: string | null | undefined, cli?: string | null): Record<string, string> {
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
  // CLI selection + the CLI's own credential env var(s). The harness shells out to
  // CLAWHUB_CLI and reads the matching *_API_KEY/token. Legacy rows (no cli) →
  // "claude" → ANTHROPIC_API_KEY, exactly the historical behavior.
  const selectedCli: AgentCli = cli && (VALID_CLIS as readonly string[]).includes(cli) ? (cli as AgentCli) : "claude";
  env.CLAWHUB_CLI = selectedCli;
  if (k) for (const v of CLI_KEY_ENVS[selectedCli]) env[v] = k;
  return env;
}

/**
 * The full env injected into a standing-agent container: ClawHub context + the
 * agent push token + the LLM creds. Pure (takes already-unsealed secrets) so the
 * shape is unit-testable. The runner merges this over process.env and repo
 * secrets and passes each as a `-e` to `docker run`.
 */
export function buildStandingEnv(args: {
  sa: Pick<StandingAgent, "id" | "llmProvider" | "llmBaseUrl" | "task" | "mode" | "cli">;
  clawhubUrl: string;
  repo: string;          // "<ns>/<repo>"
  commit: string;
  token: string;         // unsealed agent JWT
  llmKey: string | null; // unsealed LLM key
  runId?: string;        // the ci_run id — a stable idempotency key for the agent
  memoryPack?: string;   // fenced, token-budgeted recalled-memory pack (JSON)
}): Record<string, string> {
  const env: Record<string, string> = {
    CLAWHUB_URL: args.clawhubUrl,
    CLAWHUB_TOKEN: args.token,
    CLAWHUB_REPO: args.repo,
    CLAWHUB_COMMIT: args.commit,
    CLAWHUB_TASK: args.sa.task ?? "",
    CLAWHUB_STANDING_AGENT_ID: args.sa.id,
    // The agent run mode. Different modes feed one memory (worker/review emit
    // episodes; reflect distills them into conventions). See docs/memory.md.
    CLAWHUB_MODE: args.sa.mode ?? "worker",
    // Stable per-run id. A run can be re-delivered (runner reconnect, at-least-once
    // re-publish) — the container should key its work on this so a retry doesn't
    // duplicate it (e.g. branch name agent/<runId>, or skip if already pushed).
    CLAWHUB_RUN_ID: args.runId ?? "",
    ...standingLlmEnv(args.sa.llmProvider, args.sa.llmBaseUrl, args.llmKey, args.sa.cli),
  };
  // Pre-retrieved memory pack — the container has working memory the moment it
  // boots. UNTRUSTED data (fenced), token-budgeted. Empty when memory is off/empty.
  if (args.memoryPack) env.CLAWHUB_MEMORY = args.memoryPack;
  return env;
}

/** Pure: is an agent under its per-agent dispatch rate cap given its recent run count? */
export function withinStandingRateCap(recentCount: number): boolean {
  return recentCount < STANDING_RATE_CAP;
}

/**
 * Pure: is a continuous agent due to tick? Due when the interval has elapsed
 * since the last run AND any failure-backoff hold (nextEligibleAt) has passed.
 * never-run + no hold → due.
 */
export function continuousDue(lastRunAt: Date | null, intervalSec: number, now: Date, nextEligibleAt?: Date | null): boolean {
  if (nextEligibleAt && now.getTime() < nextEligibleAt.getTime()) return false;
  return now.getTime() - (lastRunAt?.getTime() ?? 0) >= intervalSec * 1000;
}

/**
 * Pure: the standing-agent state patch after a run terminates. On success, reset
 * the failure counter + clear the backoff hold. On failure, increment the
 * counter; once it reaches the ceiling the circuit breaker auto-pauses the agent
 * (enabled=false) so a flapping agent stops burning budget and surfaces to a
 * human; otherwise hold the next continuous tick with exponential backoff.
 */
export function computeFailureState(
  prevConsecutiveFailures: number,
  intervalSec: number,
  now: Date,
  outcome: "success" | "failure",
  note?: string,
): { status: string; consecutiveFailures: number; nextEligibleAt: Date | null; lastError: string | null; enabled?: boolean } {
  if (outcome === "success") {
    return { status: "idle", consecutiveFailures: 0, nextEligibleAt: null, lastError: null };
  }
  const failures = prevConsecutiveFailures + 1;
  if (failures >= STANDING_MAX_CONSECUTIVE_FAILURES) {
    return {
      status: "error", consecutiveFailures: failures, nextEligibleAt: null, enabled: false,
      lastError: `auto-paused after ${failures} consecutive failures${note ? `: ${note}` : ""} — fix + resume`,
    };
  }
  const backoffMs = intervalSec * 1000 * Math.pow(2, Math.min(failures, STANDING_BACKOFF_CAP));
  return {
    status: "error", consecutiveFailures: failures, nextEligibleAt: new Date(now.getTime() + backoffMs),
    lastError: note ?? "last run failed — see ci run step output",
  };
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
    // The operator must OWN the agent — possessing its token isn't enough, because
    // creating a standing agent grants the agent permanent writer on the repo. A
    // borrowed/foreign token must not silently mint a cross-account grant. The
    // ONE exception: a role deploy attaching the role's OWN dedicated agent — that
    // path is already authorized at the route (role owner / org admin), and an org
    // role is a shared primitive whose agent is claimed to the creator, not every
    // co-admin who may deploy it. roleOwnedAgentId names that vetted agent.
    if (agent.id !== input.roleOwnedAgentId && agent.associatedUserId !== input.createdByUserId) {
      throw new ForbiddenError("that agent is not claimed to you — claim it first, or use agentName for a dedicated one");
    }
    const s = seal(input.agentToken);
    return { agentId: agent.id, ciphertext: s.ciphertext, nonce: s.nonce };
  }
  if (input.agentName) {
    if (!NAME_RE.test(input.agentName)) throw new ValidationError("bad agentName");
    const existing = (await db.select().from(agents).where(eq(agents.name, input.agentName)).limit(1))[0];
    if (existing) {
      // Only the owner may repurpose an existing agent as a standing worker.
      if (existing.associatedUserId !== input.createdByUserId) throw new ForbiddenError("agent exists and is not yours; pass a fresh agentName or its agentToken");
      // Re-issuing its token revokes whatever token it's using elsewhere, so
      // require explicit opt-in rather than silently breaking a live session.
      if (!input.rotateToken) throw new ValidationError(`agent "${input.agentName}" already exists — re-issuing its token for the harness will revoke its current token; pass rotateToken:true to proceed, or choose a new name`);
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
  // Default to the reference harness when the caller brings no image, so a
  // logged-in human can attach a working agent with just an LLM key.
  const image = input.image?.trim() || DEFAULT_HARNESS_IMAGE;
  validateStandingConfig({ ...input, image });
  const trigger = (input.trigger ?? "manual") as StandingTrigger;
  const provider = (input.llmProvider ?? "anthropic") as LlmProvider;
  const { agentId, ciphertext, nonce } = await resolveIdentity(db, input);

  // Grant the acting agent rights on the repo (idempotent). A pure reviewer role
  // gets `reviewer` (least privilege — it can review but not push); everything
  // else gets `writer`.
  await db.insert(repoCollaborators).values({ repoId: input.repoId, agentId, role: input.grantRole ?? "writer" }).onConflictDoNothing();

  const llmSeal = input.llmApiKey ? seal(input.llmApiKey) : null;
  const [row] = await db.insert(standingAgents).values({
    repoId: input.repoId,
    agentId,
    name: input.name,
    image,
    command: input.command ?? null,
    trigger,
    cron: input.cron ?? null,
    event: input.event ?? null,
    intervalSec: input.intervalSec ?? 300,
    mode: input.mode ?? "worker",
    task: input.task ?? "",
    llmProvider: provider,
    cli: input.cli ?? "claude",
    llmBaseUrl: input.llmBaseUrl ?? null,
    llmCiphertext: llmSeal?.ciphertext ?? null,
    llmNonce: llmSeal?.nonce ?? null,
    tokenCiphertext: ciphertext,
    tokenNonce: nonce,
    memoryMb: input.memoryMb ?? 1024,
    cpus: input.cpus ?? 1,
    timeoutSec: input.timeoutSec ?? 1800,
    egressPolicy: (input.egressPolicy ?? "none") as EgressPolicy,
    egressAllowedHosts: input.egressAllowedHosts ? sanitizeEgressHosts(input.egressAllowedHosts) : [],
    roleId: input.roleId ?? null,
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
    cli: input.cli ?? existing.cli,
    image: input.image ?? existing.image,
    name: input.name ?? existing.name,
    memoryMb: input.memoryMb ?? existing.memoryMb,
    cpus: input.cpus ?? existing.cpus,
    timeoutSec: input.timeoutSec ?? existing.timeoutSec,
    egressPolicy: input.egressPolicy ?? existing.egressPolicy,
  });
  const patch: Partial<typeof standingAgents.$inferInsert> = {};
  for (const k of ["name", "image", "command", "trigger", "cron", "event", "intervalSec", "mode", "task", "llmProvider", "cli", "llmBaseUrl", "memoryMb", "cpus", "timeoutSec", "egressPolicy", "enabled"] as const) {
    if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = input[k];
  }
  // The host list is sanitized (not a free pass-through) so a patch can't widen
  // egress with a malformed entry.
  if (input.egressAllowedHosts !== undefined) patch.egressAllowedHosts = sanitizeEgressHosts(input.egressAllowedHosts);
  if (input.llmApiKey !== undefined) {
    if (input.llmApiKey) { const s = seal(input.llmApiKey); patch.llmCiphertext = s.ciphertext; patch.llmNonce = s.nonce; }
    else { patch.llmCiphertext = null; patch.llmNonce = null; }
  }
  // `status` is the run lifecycle (idle | running | error); "paused" is derived
  // from `enabled` in the UI. Re-enabling FULLY resets the circuit breaker —
  // clears the error, the failure counter, and the backoff hold — so a resumed
  // agent starts clean instead of re-tripping after a single failure (otherwise
  // the breaker is a one-way trap: it pauses at the ceiling and re-pauses on the
  // very next failure because consecutiveFailures was never reset).
  if (input.enabled === true) { patch.status = "idle"; patch.lastError = null; patch.consecutiveFailures = 0; patch.nextEligibleAt = null; }
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

/** The non-secret `ci.run.queued` payload for a standing run. Reused by re-publish. */
function queuedPayload(sa: StandingAgent, target: { ns: string; repoName: string; commit: string }, run: { id: string; runnerToken: string; commit: string | null; changeId?: string | null }) {
  return {
    runId: run.id, repoNs: target.ns, repoName: target.repoName, commit: run.commit ?? target.commit,
    // For a change-scoped run (verify/review), the head lives on a Change ref the
    // clone won't fetch — the runner fetches it by this id before checkout.
    changeId: run.changeId ?? undefined,
    runnerToken: run.runnerToken, standing: true as const, image: sa.image, command: sa.command ?? undefined,
    timeoutSec: sa.timeoutSec, memoryMb: sa.memoryMb, cpus: sa.cpus,
    // Network containment for the runner. Not secret (host names only); the sealed
    // creds still flow solely through the gated secrets endpoint.
    egress: { policy: sa.egressPolicy as EgressPolicy, allowedHosts: sa.egressAllowedHosts ?? [] },
  };
}

/**
 * Dispatch one standing-agent tick: governance-check, then create a ci_runs row
 * (origin='agent', pipelineId null) at the repo default-branch HEAD and publish
 * ci.run.queued so the runner picks it up. The image/command live on the standing
 * agent row; the runner reads them from the secrets endpoint (gated by the per-run
 * token). The sealed agent token + LLM key are NEVER in the published event.
 *
 * IDEMPOTENT: the in-flight check + insert run under a per-agent Postgres advisory
 * lock (cluster-wide, so multi-replica safe), and the partial unique index on
 * pending standing runs is the backstop — two concurrent ticks can NEVER produce
 * two runs for the same agent. The event publish happens after the lock; a
 * re-delivered event is harmless because the runner's claim is atomic.
 */
export async function dispatchStandingRun(
  db: DB,
  events: EventBus,
  sa: StandingAgent,
  opts: { manual?: boolean; commit?: string; changeId?: string } = {},
): Promise<DispatchResult> {
  if (!sa.enabled && !opts.manual) return { ok: false, reason: "disabled" };

  if (await isAgentKilled(db, sa.agentId)) {
    await markStatus(db, sa.id, "error", "agent kill switch engaged");
    metrics.inc("clawhub_standing_dispatch_total", { outcome: "killed" });
    return { ok: false, reason: "killed" };
  }
  const budget = await checkAgentBudget(db, sa.agentId);
  if (!budget.ok) {
    await markStatus(db, sa.id, "error", `cost budget exceeded (${budget.spentCents}/${budget.limitCents} cents)`);
    metrics.inc("clawhub_standing_dispatch_total", { outcome: "over_budget" });
    return { ok: false, reason: "over_budget" };
  }
  // Org-wide cap: a dispatch for an org repo is also subject to the org budget —
  // enforcement is min(agent cap, org cap). (cost_budgets.orgId was a dead column
  // until now.)
  const repoOwner = (await db.select({ namespaceType: repositories.namespaceType, namespaceId: repositories.namespaceId })
    .from(repositories).where(eq(repositories.id, sa.repoId)).limit(1))[0];
  if (repoOwner?.namespaceType === "org") {
    const orgBudget = await checkOrgBudget(db, repoOwner.namespaceId);
    if (!orgBudget.ok) {
      await markStatus(db, sa.id, "error", `org cost budget exceeded (${orgBudget.spentCents}/${orgBudget.limitCents} cents)`);
      metrics.inc("clawhub_standing_dispatch_total", { outcome: "over_budget" });
      return { ok: false, reason: "over_budget" };
    }
  }
  const target = await resolveRepoTarget(db, sa.repoId);
  if (!target) {
    log("warn", "standing_target_unresolved", { id: sa.id, repoId: sa.repoId });
    metrics.inc("clawhub_standing_dispatch_total", { outcome: "unresolved" });
    return { ok: false, reason: "unresolved" };
  }

  // Per-agent serialization: the in-flight + rate-cap check + insert is atomic so
  // two concurrent ticks can't both create a run. `withChangeUpsertLock` takes a
  // Postgres advisory lock keyed on (sa.id|"standing") inside a transaction.
  type Outcome = { kind: "ok"; run: typeof ciRuns.$inferSelect } | { kind: "in_flight" } | { kind: "rate_capped" };
  let outcome: Outcome;
  try {
    outcome = await withChangeUpsertLock(db, sa.id, "standing", async tx => {
      if (await hasRunInFlight(tx, sa.id)) return { kind: "in_flight" } as Outcome;
      // Per-agent backstop: bounds ANY loop shape (tiny interval, event
      // self-trigger, manual spam) independent of how it forms.
      if (!withinStandingRateCap(await recentRunCount(tx, sa.id))) return { kind: "rate_capped" } as Outcome;
      const runnerToken = randomToken(18);
      const [run] = await tx.insert(ciRuns).values({
        repoId: sa.repoId, standingAgentId: sa.id, runnerToken, origin: "agent",
        // A verify/review tick triggered by a change event binds to that change's
        // EXACT head (passed by the dispatcher) — verified autonomy keys off
        // run.commit === change.headCommit. Other ticks target default-branch HEAD.
        commit: opts.commit ?? target.commit,
        // changeId links a change-scoped run to its change (recomputeChangeCiStatus
        // still ignores pipeline-less runs, so this never votes on CI). Else null.
        changeId: opts.changeId ?? null,
      }).returning();
      await tx.update(standingAgents).set({ status: "running", lastRunId: run.id, lastRunAt: new Date(), lastError: null }).where(eq(standingAgents.id, sa.id));
      return { kind: "ok", run } as Outcome;
    });
  } catch (e) {
    // Lost the partial-unique-index race (a concurrent pending run already exists).
    if ((e as { code?: string }).code === "23505") {
      metrics.inc("clawhub_standing_dispatch_total", { outcome: "in_flight" });
      return { ok: false, reason: "in_flight" };
    }
    throw e;
  }

  if (outcome.kind === "in_flight") return { ok: false, reason: "in_flight" };
  if (outcome.kind === "rate_capped") {
    log("warn", "standing_rate_capped", { id: sa.id, cap: STANDING_RATE_CAP });
    await markStatus(db, sa.id, "error", `rate cap reached (${STANDING_RATE_CAP}/${STANDING_RATE_WINDOW_MS / 60000}m)`);
    metrics.inc("clawhub_standing_dispatch_total", { outcome: "rate_capped" });
    return { ok: false, reason: "rate_capped" };
  }

  await events.publish({
    type: "ci.run.queued",
    repoId: sa.repoId,
    actorKind: "system",
    actorId: "standing-agent",
    payload: queuedPayload(sa, target, outcome.run),
  });
  metrics.inc("clawhub_standing_dispatch_total", { outcome: "queued" });
  log("info", "standing_run_queued", { id: sa.id, runId: outcome.run.id, commit: target.commit });
  return { ok: true, runId: outcome.run.id };
}

/**
 * Record a terminal standing run's outcome on its agent: reset on success, or
 * increment the failure counter (exponential backoff, then circuit-breaker
 * auto-pause). Called from the runner-callback path + the stale-run reaper.
 *
 * Correctness guards (the failure counter drives backoff + auto-pause, so it must
 * not be corrupted):
 *  - Serialized under the SAME per-agent advisory lock as dispatch, so the
 *    read-modify-write of consecutiveFailures can't lose an increment to a
 *    concurrent transition (multi-replica safe).
 *  - `runId` must be the agent's CURRENT run (`lastRunId`). A reaped/superseded
 *    run's late terminal report is a no-op — it can't clobber a newer cycle's
 *    state or double-count.
 *  - A paused / circuit-broken agent (`!enabled`) is left untouched — only an
 *    explicit resume clears the breaker, so a stray success can't silently
 *    re-arm it.
 */
export async function recordStandingRunResult(db: DB, standingAgentId: string, runId: string, outcome: "success" | "failure", note?: string, now: Date = new Date()): Promise<void> {
  const result = await withChangeUpsertLock(db, standingAgentId, "standing", async tx => {
    const sa = (await tx.select().from(standingAgents).where(eq(standingAgents.id, standingAgentId)).limit(1))[0];
    if (!sa) return { applied: "missing" as const, tripped: null as number | null };
    if (sa.lastRunId !== runId) return { applied: "stale" as const, tripped: null as number | null };
    if (!sa.enabled) return { applied: "paused" as const, tripped: null as number | null };
    const patch = computeFailureState(sa.consecutiveFailures, sa.intervalSec, now, outcome, note);
    await tx.update(standingAgents).set(patch).where(eq(standingAgents.id, standingAgentId));
    return { applied: "applied" as const, tripped: patch.enabled === false ? patch.consecutiveFailures : null };
  });
  // Count the run outcome; flag stale/paused no-ops distinctly for observability.
  metrics.inc("clawhub_standing_runs_total", { outcome: result.applied === "applied" ? outcome : `${outcome}_${result.applied}` });
  if (result.tripped !== null) log("warn", "standing_circuit_breaker_tripped", { id: standingAgentId, failures: result.tripped });
}

/**
 * At-least-once delivery: re-publish ci.run.queued for standing runs that have
 * been PENDING and unclaimed past the window — a runner was offline when the
 * original event fired, or the API crashed after the insert but before publish.
 * The runner's atomic claim de-dups, so re-publishing a since-claimed run is a
 * no-op. Driven from the standing scheduler tick. Returns the number re-published.
 *
 * Multi-replica note: every API replica's tick runs this, so a stale run may be
 * re-published N times — but the runner's atomic pending→running claim means only
 * one execution results. The cost is N× duplicate events, never a double-run. A
 * per-run claim column would remove the waste if replica count grows.
 */
export async function republishStalePendingStandingRuns(db: DB, events: EventBus, now: Date = new Date(), limit = 50): Promise<number> {
  const cutoff = new Date(now.getTime() - STANDING_REPUBLISH_AFTER_MS);
  const stale = await db.select().from(ciRuns).where(and(
    isNotNull(ciRuns.standingAgentId),
    eq(ciRuns.status, "pending"),
    isNull(ciRuns.startedAt),
    lt(ciRuns.createdAt, cutoff),
  )).limit(limit);
  let n = 0;
  for (const run of stale) {
    const sa = (await db.select().from(standingAgents).where(eq(standingAgents.id, run.standingAgentId!)).limit(1))[0];
    if (!sa) continue;
    // Don't resurrect a run for an agent that was paused / circuit-broken / killed
    // since it was queued. Cancel the orphan so it stops being re-selected and a
    // runner can't later claim it. (The agent was disabled with intent; honoring
    // a stale queued run would silently override that.)
    if (!sa.enabled || (await isAgentKilled(db, sa.agentId))) {
      await db.update(ciRuns).set({ status: "skipped", finishedAt: new Date(), stepResults: [{ name: "cancelled", note: "standing agent paused/killed before this run was claimed" }] })
        .where(and(eq(ciRuns.id, run.id), eq(ciRuns.status, "pending")));
      continue;
    }
    const target = await resolveRepoTarget(db, run.repoId);
    if (!target) continue;
    await events.publish({
      type: "ci.run.queued", repoId: run.repoId, actorKind: "system", actorId: "standing-agent-republish",
      payload: queuedPayload(sa, target, run),
    });
    n++;
  }
  if (n) { metrics.inc("clawhub_standing_runs_republished_total", {}, n); log("info", "standing_runs_republished", { count: n }); }
  return n;
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
export async function standingRunEnv(db: DB, run: { id: string; standingAgentId: string | null; commit: string | null; repoId: string }, clawhubUrl: string): Promise<Record<string, string> | null> {
  if (!run.standingAgentId) return null;
  const sa = (await db.select().from(standingAgents).where(eq(standingAgents.id, run.standingAgentId)).limit(1))[0];
  if (!sa) return null;
  const target = await resolveRepoTarget(db, sa.repoId);
  const repo = target ? `${target.ns}/${target.repoName}` : "";
  let token = "";
  try { token = unseal(sa.tokenCiphertext, sa.tokenNonce); } catch { /* sealing key changed; token unrecoverable */ }
  let llmKey: string | null = null;
  if (sa.llmCiphertext && sa.llmNonce) { try { llmKey = unseal(sa.llmCiphertext, sa.llmNonce); } catch { llmKey = null; } }
  // Pre-retrieve the memory pack for this run (best-effort — memory is additive,
  // a failure here must not block the run). Scoped to (this agent, this repo).
  let memoryPack: string | undefined;
  try {
    const ids = await resolveScopeIds(db, sa.agentId, sa.repoId);
    memoryPack = await buildMemoryPack(db, ids, {});
  } catch (e) { log("warn", "standing_memory_pack_failed", { id: sa.id, err: (e as Error).message }); }
  return buildStandingEnv({
    sa,
    clawhubUrl,
    repo,
    commit: run.commit ?? target?.commit ?? "",
    token,
    llmKey,
    runId: run.id,
    memoryPack,
  });
}
