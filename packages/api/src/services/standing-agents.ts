import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, ciRuns, repoCollaborators, repositories, standingAgents } from "../models/schema.js";
import type { StandingAgent } from "../models/schema.js";
import type { EventBus } from "./events.js";
import { seal, unseal } from "./secrets.js";
import { expandWorkflowTask } from "./agent-workflows.js";
import { hashToken, matchesHash, randomToken, signToken, verifyToken } from "./auth.js";
import { resolveRepoTarget } from "./ci-trigger.js";
import { isAgentKilled } from "./kill-switch.js";
import { checkAgentBudget, checkOrgBudget } from "./cost-ledger.js";
import { withChangeUpsertLock } from "./repo-lock.js";
import { parseCron } from "./cron.js";
import { buildMemoryPack, resolveScopeIds } from "./memory.js";
import { mintGatewayToken } from "./llm-gateway.js";
import { resolveSpec } from "./spec-resolver.js";
import { loadActiveVerifyPlan, currentPlanAnchors, isPlanStale } from "./verify-plan.js";
import { agentPriorityClass, agentResourceRequest, defaultMaxAttempts } from "./job-scheduling.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { catalogEntry } from "./llm-catalog.js";
import { agentRunGroup, collapseStalePending, hasLiveRunForVersion } from "./run-leases.js";

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

export const VALID_TRIGGERS = ["manual", "continuous", "schedule", "event", "quiet"] as const;
// Common LLM providers/aggregators. A BYO agent picks one + supplies ONE key; the
// key is injected under that provider's conventional env var(s) and (for OpenAI-
// compatible providers) the base URL is set so any client reaches it. "custom" +
// llmBaseUrl covers anything not listed. Researched 2026-06 (docs/agent-providers.md).
export const VALID_PROVIDERS = [
  "anthropic", "openai", "openrouter", "gemini", "google", "mistral", "cohere",
  "groq", "together", "fireworks", "deepseek", "xai", "perplexity", "cerebras",
  "hyperbolic", "nvidia", "requesty", "azure", "litellm", "ollama", "custom",
] as const;
export const VALID_EGRESS = ["none", "allowlist", "all"] as const;
// The coding-agent CLI the harness shells out to. Orthogonal to the LLM provider
// (the credential/backend): the harness reads CLAWHUB_CLI and runs that CLI, and
// the single sealed key is injected under whatever env var that CLI reads.
export const VALID_CLIS = ["claude", "copilot", "codex", "gemini", "aider", "cline", "goose", "cursor", "continue"] as const;
export type StandingTrigger = (typeof VALID_TRIGGERS)[number];
export type LlmProvider = (typeof VALID_PROVIDERS)[number];
export type EgressPolicy = (typeof VALID_EGRESS)[number];
export type AgentCli = (typeof VALID_CLIS)[number];

// The credential env var(s) each CLI reads for its OWN gateway/token (beyond the
// provider vars below). Model-agnostic CLIs (aider/cline/goose/continue) read the
// provider's vars, so they map to []. claude→Anthropic; codex→OpenAI; gemini→
// Google; copilot→a GitHub token; cursor→a Cursor account key.
export const CLI_KEY_ENVS: Record<AgentCli, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  copilot: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  cursor: ["CURSOR_API_KEY"],
  cline: ["CLINE_API_KEY"],
  continue: ["CONTINUE_API_KEY"],
  aider: [],
  goose: [],
};

// provider → the env var(s) its SDK/CLI reads for the key + (for OpenAI-compatible
// providers) the default base URL + any named base-url env vars. Injecting one key
// under all of these makes "bring a key for provider X" just work. See standingLlmEnv.
export const PROVIDER_ENV: Record<string, { keyEnvVars: string[]; baseUrl?: string; baseUrlEnvVars?: string[] }> = {
  openai: { keyEnvVars: ["OPENAI_API_KEY"], baseUrlEnvVars: ["OPENAI_BASE_URL"] },
  anthropic: { keyEnvVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], baseUrlEnvVars: ["ANTHROPIC_BASE_URL"] },
  gemini: { keyEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  google: { keyEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  mistral: { keyEnvVars: ["MISTRAL_API_KEY"], baseUrl: "https://api.mistral.ai/v1" },
  cohere: { keyEnvVars: ["CO_API_KEY", "COHERE_API_KEY"], baseUrlEnvVars: ["CO_API_URL"] },
  groq: { keyEnvVars: ["GROQ_API_KEY"], baseUrl: "https://api.groq.com/openai/v1" },
  together: { keyEnvVars: ["TOGETHER_API_KEY"], baseUrl: "https://api.together.xyz/v1", baseUrlEnvVars: ["TOGETHER_BASE_URL"] },
  fireworks: { keyEnvVars: ["FIREWORKS_API_KEY"], baseUrl: "https://api.fireworks.ai/inference/v1" },
  deepseek: { keyEnvVars: ["DEEPSEEK_API_KEY"], baseUrl: "https://api.deepseek.com" },
  xai: { keyEnvVars: ["XAI_API_KEY"], baseUrl: "https://api.x.ai/v1" },
  perplexity: { keyEnvVars: ["PERPLEXITY_API_KEY"], baseUrl: "https://api.perplexity.ai" },
  cerebras: { keyEnvVars: ["CEREBRAS_API_KEY"], baseUrl: "https://api.cerebras.ai/v1" },
  hyperbolic: { keyEnvVars: ["HYPERBOLIC_API_KEY"], baseUrl: "https://api.hyperbolic.xyz/v1" },
  nvidia: { keyEnvVars: ["NVIDIA_API_KEY"], baseUrl: "https://integrate.api.nvidia.com/v1" },
  openrouter: { keyEnvVars: ["OPENROUTER_API_KEY"], baseUrl: "https://openrouter.ai/api/v1", baseUrlEnvVars: ["OPENROUTER_BASE_URL"] },
  requesty: { keyEnvVars: ["REQUESTY_API_KEY"], baseUrl: "https://router.requesty.ai/v1", baseUrlEnvVars: ["REQUESTY_BASE_URL"] },
  azure: { keyEnvVars: ["AZURE_OPENAI_API_KEY"], baseUrlEnvVars: ["AZURE_OPENAI_ENDPOINT"] },
  litellm: { keyEnvVars: ["LITELLM_PROXY_API_KEY", "LITELLM_API_KEY"], baseUrlEnvVars: ["LITELLM_PROXY_API_BASE"] },
  ollama: { keyEnvVars: [], baseUrlEnvVars: ["OLLAMA_HOST"] },
  custom: { keyEnvVars: ["LLM_API_KEY"] },
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
  // v4: null = a GLOBAL (repo-less) deployment — it reaches every repo the
  // agent's role scope + its owner's governance admit; the target repo is
  // resolved at dispatch time (workflow scope / thread context).
  repoId: string | null;
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
  // v3 BYO execution style: "cli" (default) or "api" (harness API loop).
  execStyle?: string;
  model?: string | null;   // optional model override → CLAWHUB_MODEL → CLI --model (e.g. "sonnet")
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
  // Internal (N5 platform-key Loop / system agents): route this agent through the
  // metering gateway on the platform key. NOT settable from request bodies — the
  // standing-agents route never forwards it (D2: platform key is closed to
  // user-authored agents; only loop install + the system reviewer/verifier set it).
  keySource?: "byo" | "platform";
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
  execStyle?: string;
  model?: string | null;
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
  // Inject the single key under the provider's conventional env var(s) + resolve
  // the base URL. An unknown provider falls to "custom" (just LLM_API_KEY + the
  // caller's llmBaseUrl). See PROVIDER_ENV.
  const p = PROVIDER_ENV[provider] ?? PROVIDER_ENV.custom;
  if (k) for (const v of p.keyEnvVars) env[v] = k;
  const resolvedBase = baseUrl || p.baseUrl;
  if (resolvedBase) {
    for (const v of p.baseUrlEnvVars ?? []) env[v] = resolvedBase;
    // OpenAI-compatible providers (those with a default compat baseUrl) are reached
    // by pointing OPENAI_BASE_URL at them — the near-universal compat convention, so
    // any OpenAI-SDK-based CLI/tool works with just the key.
    if (p.baseUrl) {
      if (k && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = k;
      env.OPENAI_BASE_URL = resolvedBase;
      env.OPENAI_API_BASE = resolvedBase;
    }
    env.LLM_BASE_URL = resolvedBase;
  }
  // CLI selection + the CLI's own credential env var(s). Legacy rows (no cli) →
  // "claude" → ANTHROPIC_API_KEY, exactly the historical behavior.
  const selectedCli: AgentCli = cli && (VALID_CLIS as readonly string[]).includes(cli) ? (cli as AgentCli) : "claude";
  env.CLAWHUB_CLI = selectedCli;
  if (k) for (const v of CLI_KEY_ENVS[selectedCli]) env[v] = k;
  // A Claude Max/Pro SUBSCRIPTION token (`sk-ant-oat…`, from `claude setup-token`) authenticates
  // the claude CLI via CLAUDE_CODE_OAUTH_TOKEN — NOT ANTHROPIC_API_KEY. Setting an oat token as
  // the API key makes the CLI take the (wrong) direct-API path and fail ("Not logged in"). Route
  // it to the OAuth var and clear the API-key vars so the subscription auth is used.
  if (k && selectedCli === "claude" && k.startsWith("sk-ant-oat")) {
    env.CLAUDE_CODE_OAUTH_TOKEN = k;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

/**
 * The full env injected into a standing-agent container: ClawHub context + the
 * agent push token + the LLM creds. Pure (takes already-unsealed secrets) so the
 * shape is unit-testable. The runner merges this over process.env and repo
 * secrets and passes each as a `-e` to `docker run`.
 */
export function buildStandingEnv(args: {
  sa: Pick<StandingAgent, "id" | "llmProvider" | "llmBaseUrl" | "task" | "mode" | "cli" | "model">;
  clawhubUrl: string;
  repo: string;          // "<ns>/<repo>"
  commit: string;
  token: string;         // unsealed agent JWT
  llmKey: string | null; // unsealed LLM key
  runId?: string;        // the ci_run id — a stable idempotency key for the agent
  memoryPack?: string;   // fenced, token-budgeted recalled-memory pack (JSON)
  taskOverride?: string | null; // per-run ad-hoc task (manual tick) — overrides sa.task
  issue?: number | null;        // per-run issue number to point the agent at (manual tick)
  changeId?: string | null;     // the Change a pinned run (verify/review) targets
  // Platform key custody (M3): when set, the container is routed through the
  // metering gateway instead of receiving a raw LLM key. The gateway TOKEN
  // becomes the CLI's "API key" and `baseUrl` its endpoint — the real platform
  // key never enters the container. Used by keySource='platform' system agents.
  platformGateway?: { baseUrl: string; token: string } | null;
}): Record<string, string> {
  // keySource='platform' → route through the gateway (token as key, gateway URL
  // as base). Otherwise inject the BYO key directly, as before. Only the LLM env
  // differs; everything else is identical.
  const llmEnv = args.platformGateway
    ? standingLlmEnv(args.sa.llmProvider, args.platformGateway.baseUrl, args.platformGateway.token, args.sa.cli)
    : standingLlmEnv(args.sa.llmProvider, args.sa.llmBaseUrl, args.llmKey, args.sa.cli);
  const expandedTask = expandWorkflowTask(args.taskOverride || (args.sa.task ?? ""));
  const env: Record<string, string> = {
    CLAWHUB_URL: args.clawhubUrl,
    CLAWHUB_TOKEN: args.token,
    CLAWHUB_REPO: args.repo,
    CLAWHUB_COMMIT: args.commit,
    // A manual tick's ad-hoc task (the operator's prompt) overrides the agent's stored task,
    // so an IDLE develop agent can be pointed at work on demand. Falls back to sa.task.
    // Slash workflows ("/dev", "/review", "/loop" …) expand HERE — one point that
    // covers scheduled, triggered, and manual runs identically (agent-workflows.ts).
    CLAWHUB_TASK: expandedTask.task,
    CLAWHUB_STANDING_AGENT_ID: args.sa.id,
    // The agent run mode. Different modes feed one memory (worker/review emit
    // episodes; reflect distills them into conventions). See docs/memory.md.
    // A slash workflow pins its own mode (a "/verify" task must run the verify
    // harness path regardless of how the agent was configured).
    CLAWHUB_MODE: expandedTask.mode ?? args.sa.mode ?? "worker",
    // Stable per-run id. A run can be re-delivered (runner reconnect, at-least-once
    // re-publish) — the container should key its work on this so a retry doesn't
    // duplicate it (e.g. branch name agent/<runId>, or skip if already pushed).
    CLAWHUB_RUN_ID: args.runId ?? "",
    ...llmEnv,
  };
  // Optional model override → the harness passes it to the CLI's --model flag
  // (e.g. CLAWHUB_MODEL=sonnet pins claude to Sonnet). Absent → the CLI's default.
  if (args.sa.model) env.CLAWHUB_MODEL = args.sa.model;
  // v3 BYO execution style: "cli" (default, shell out to the coding-agent CLI)
  // or "api" (harness API loop — driver ships in the next harness image batch).
  env.CLAWHUB_EXEC_STYLE = (args.sa as { execStyle?: string }).execStyle === "api" ? "api" : "cli";
  // A specific issue to work (manual tick) — the harness fetches issue #N as the task, optionally
  // combined with taskOverride (the prompt then says what to do with/around that issue).
  if (args.issue) env.CLAWHUB_ISSUE = String(args.issue);
  // The Change a pinned run targets (verify/review on change.opened). The harness
  // uses it to fetch the Change ref/diff and to key memory facts (facts.changeId).
  if (args.changeId) env.CLAWHUB_CHANGE_ID = args.changeId;
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
 * Pure: is a `quiet`-triggered agent due? Debounce-until-quiet (the reflection-
 * scheduling consensus — consolidate OFF the hot path, after activity settles):
 * due when there HAS been repo activity since the agent's last run AND that
 * activity is at least `quietSec` old (the repo has gone quiet). `intervalSec`
 * doubles as the quiet window for this trigger. New activity resets the clock;
 * a repo with no new activity since the last run never re-fires.
 */
export function quietDue(lastActivityAt: Date | null, lastRunAt: Date | null, quietSec: number, now: Date, nextEligibleAt?: Date | null): boolean {
  if (nextEligibleAt && now.getTime() < nextEligibleAt.getTime()) return false;
  if (!lastActivityAt) return false; // nothing has ever happened — nothing to reflect on
  if (lastRunAt && lastRunAt.getTime() >= lastActivityAt.getTime()) return false; // no NEW activity since the last run
  return now.getTime() - lastActivityAt.getTime() >= quietSec * 1000;
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

// v3: modes that run the AGENTIC harness loop (multi-turn tool calling).
// review/triage are single-shot-capable and accept any catalog model.
export const AGENTIC_MODES = new Set(["worker", "develop", "verify", "reflect"]);

/**
 * v3 model × mode validation: a PLATFORM-keyed agent pinning a catalog model
 * that cannot run the agentic loop (e.g. DeepSeek's thinking-mode tool-call
 * trap) must not be deployed into an agentic mode — it would just break at
 * runtime. BYO rows are untouched (their model names are CLI aliases like
 * "sonnet", not catalog slugs).
 */
export function validateModelForMode(keySource: "byo" | "platform" | undefined, model: string | null | undefined, mode: string): void {
  if (keySource !== "platform" || !model) return;
  const entry = catalogEntry(model);
  if (entry && entry.agentic === false && AGENTIC_MODES.has(mode)) {
    throw new ValidationError(`model_not_agentic: ${model} is single-shot only (review/triage) — it cannot run the ${mode} loop; pick an agentic model like z-ai/glm-5.2`);
  }
}

/** Strip secrets/internal columns from a row before returning over the API. */
export function redactStanding(sa: StandingAgent) {
  const { tokenCiphertext, tokenNonce, llmCiphertext, llmNonce, ...rest } = sa;
  return { ...rest, hasLlmKey: !!llmCiphertext };
}

export async function createStandingAgent(db: DB, input: CreateStandingInput): Promise<StandingAgent> {
  // v3: DETERMINISTIC HARNESS ONLY (docs/redesign-v3.md §3) — user-provided
  // images/commands are removed from the product. The server always stamps the
  // reference harness; a requested custom image is ignored (logged) unless the
  // self-host operator escape hatch CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES=1 is
  // set. Routes additionally 400 on explicit image/command in request bodies.
  const allowCustom = process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES === "1";
  const requestedImage = input.image?.trim();
  const image = allowCustom && requestedImage ? requestedImage : DEFAULT_HARNESS_IMAGE;
  if (requestedImage && requestedImage !== image) {
    log("warn", "custom_harness_image_ignored", { repoId: input.repoId, requested: requestedImage });
  }
  const command = allowCustom ? (input.command ?? null) : null;
  validateStandingConfig({ ...input, image });
  validateModelForMode(input.keySource, input.model, input.mode ?? "worker");
  const execStyle = input.execStyle === "api" ? "api" : "cli";
  const trigger = (input.trigger ?? "manual") as StandingTrigger;
  const provider = (input.llmProvider ?? "anthropic") as LlmProvider;
  const { agentId, ciphertext, nonce } = await resolveIdentity(db, input);

  // Grant the acting agent rights on the repo (idempotent). A pure reviewer role
  // gets `reviewer` (least privilege — it can review but not push); everything
  // else gets `writer`. A GLOBAL deployment (v4, repoId null) needs no grant:
  // the agent reaches its owner's repos via association (repoAccessFor /
  // checkPushRights admit a claimed agent on its human's namespaces), ceilinged
  // by its access role.
  if (input.repoId) {
    await db.insert(repoCollaborators).values({ repoId: input.repoId, agentId, role: input.grantRole ?? "writer" }).onConflictDoNothing();
  }

  const llmSeal = input.llmApiKey ? seal(input.llmApiKey) : null;
  const [row] = await db.insert(standingAgents).values({
    repoId: input.repoId,
    agentId,
    name: input.name,
    image,
    command,
    trigger,
    cron: input.cron ?? null,
    event: input.event ?? null,
    intervalSec: input.intervalSec ?? 300,
    mode: input.mode ?? "worker",
    task: input.task ?? "",
    llmProvider: provider,
    cli: input.cli ?? "claude",
    execStyle,
    model: input.model?.trim() || null,
    llmBaseUrl: input.llmBaseUrl ?? null,
    keySource: input.keySource === "platform" ? "platform" : "byo",
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
  // System agents (the native reviewer) are platform-owned, not a tenant's — hide
  // them from the repo's standing-agent roster.
  return db.select().from(standingAgents).where(and(eq(standingAgents.repoId, repoId), eq(standingAgents.isSystem, false))).orderBy(desc(standingAgents.createdAt));
}

// Cross-repo: every standing agent on the given repos (for a fleet operator's
// "all my standing agents" view). The caller resolves which repos it governs.
export async function listStandingAgentsForRepos(db: DB, repoIds: string[]): Promise<StandingAgent[]> {
  if (!repoIds.length) return [];
  return db.select().from(standingAgents).where(and(inArray(standingAgents.repoId, repoIds), eq(standingAgents.isSystem, false))).orderBy(desc(standingAgents.createdAt));
}

export async function getStandingAgent(db: DB, repoId: string | null, id: string): Promise<StandingAgent> {
  // v4: a GLOBAL deployment has repoId null — match it with IS NULL.
  const repoCond = repoId ? eq(standingAgents.repoId, repoId) : isNull(standingAgents.repoId);
  const row = (await db.select().from(standingAgents).where(and(eq(standingAgents.id, id), repoCond)).limit(1))[0];
  if (!row) throw new NotFoundError("standing agent");
  return row;
}

export async function updateStandingAgent(db: DB, repoId: string | null, id: string, input: UpdateStandingInput): Promise<StandingAgent> {
  const existing = await getStandingAgent(db, repoId, id);
  // v3 deterministic harness: image/command are not user-patchable (see
  // createStandingAgent). Drop them from the patch unless the operator
  // escape hatch is set.
  if (process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES !== "1") {
    delete (input as Record<string, unknown>).image;
    delete (input as Record<string, unknown>).command;
  }
  // Model × mode validation on the merged result (platform-keyed rows only).
  validateModelForMode(
    existing.keySource as "byo" | "platform",
    input.model !== undefined ? input.model : existing.model,
    input.mode ?? existing.mode,
  );
  if (input.execStyle !== undefined) (input as Record<string, unknown>).execStyle = input.execStyle === "api" ? "api" : "cli";
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
  for (const k of ["name", "image", "command", "trigger", "cron", "event", "intervalSec", "mode", "task", "llmProvider", "cli", "execStyle", "model", "llmBaseUrl", "memoryMb", "cpus", "timeoutSec", "egressPolicy", "enabled"] as const) {
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
  | { ok: false; reason: "disabled" | "killed" | "over_budget" | "in_flight" | "rate_capped" | "unresolved" | "duplicate" };

function queuedPayload(sa: StandingAgent, target: { ns: string; repoName: string; commit: string }, run: { id: string; runnerToken: string; commit: string | null; changeId?: string | null; runsOn?: string | null }, verifyTier?: string | null) {
  // The verification TIER (server-derived, from the Change at post-push). It decides
  // how much the runner/harness boot — and crucially demotes the heavy --privileged
  // Docker-in-Docker to the `dind` tier ONLY. A verify run with no computed tier
  // (a Change pushed before this shipped) falls back to `dind` so it still works.
  const effectiveTier = verifyTier ?? (sa.mode === "verify" ? "dind" : undefined);
  return {
    runId: run.id, repoNs: target.ns, repoName: target.repoName, commit: run.commit ?? target.commit,
    // For a change-scoped run (verify/review), the head lives on a Change ref the
    // clone won't fetch — the runner fetches it by this id before checkout.
    changeId: run.changeId ?? undefined,
    // The tier the harness boots (CLAWHUB_VERIFY_TIER): static|app|services|dind.
    verifyTier: effectiveTier,
    // Docker-in-Docker (--privileged) ONLY for the `dind` tier — a multi-service app
    // that needs its own Docker daemon. T0/T1/T2 run NON-privileged (cap-drop=ALL),
    // so the cheap tiers are also the strongly-isolated tiers. See runner runContainer.
    dind: effectiveTier === "dind",
    runnerToken: run.runnerToken, standing: true as const, image: sa.image, command: sa.command ?? undefined,
    timeoutSec: sa.timeoutSec, memoryMb: sa.memoryMb, cpus: sa.cpus,
    // Review-only mode (M4): the container never executes repo code, so the runner
    // SKIPS THE CLONE entirely — no repo code enters a review-only container. The
    // reviewer reads the diff via the API. Stamped SERVER-SIDE (runner obeys the
    // stamp, never the row). Egress is FORCED to `none` for a review run regardless
    // of the row (infra-only: ClawHub API + the LLM gateway).
    reviewOnly: sa.mode === "review",
    // Network containment for the runner. Not secret (host names only); the sealed
    // creds still flow solely through the gated secrets endpoint.
    egress: sa.mode === "review"
      ? { policy: "none" as EgressPolicy, allowedHosts: [] }
      : { policy: sa.egressPolicy as EgressPolicy, allowedHosts: sa.egressAllowedHosts ?? [] },
    runsOn: run.runsOn ?? undefined,
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
  opts: { manual?: boolean; commit?: string; changeId?: string; task?: string; issue?: number; model?: string; triggeredByUserId?: string; repoId?: string; workflowId?: string } = {},
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
  // v4: a GLOBAL (repo-less) deployment runs against a repo RESOLVED AT
  // DISPATCH TIME — from the workflow's scope or the thread a slash command
  // was typed in (opts.repoId). A legacy per-repo row keeps its pinned repo.
  const targetRepoId = opts.repoId ?? sa.repoId;
  if (!targetRepoId) {
    log("warn", "standing_dispatch_no_repo", { id: sa.id });
    metrics.inc("clawhub_standing_dispatch_total", { outcome: "unresolved" });
    return { ok: false, reason: "unresolved" };
  }
  // Org-wide cap: a dispatch for an org repo is also subject to the org budget —
  // enforcement is min(agent cap, org cap). (cost_budgets.orgId was a dead column
  // until now.)
  const repoOwner = (await db.select({ namespaceType: repositories.namespaceType, namespaceId: repositories.namespaceId })
    .from(repositories).where(eq(repositories.id, targetRepoId)).limit(1))[0];
  if (repoOwner?.namespaceType === "org") {
    const orgBudget = await checkOrgBudget(db, repoOwner.namespaceId);
    if (!orgBudget.ok) {
      await markStatus(db, sa.id, "error", `org cost budget exceeded (${orgBudget.spentCents}/${orgBudget.limitCents} cents)`);
      metrics.inc("clawhub_standing_dispatch_total", { outcome: "over_budget" });
      return { ok: false, reason: "over_budget" };
    }
  }
  const target = await resolveRepoTarget(db, targetRepoId);
  if (!target) {
    log("warn", "standing_target_unresolved", { id: sa.id, repoId: targetRepoId });
    metrics.inc("clawhub_standing_dispatch_total", { outcome: "unresolved" });
    return { ok: false, reason: "unresolved" };
  }

  // Read the change's verify tier up front (computed at post-push) so the run's
  // persisted resource request reflects the tier — the scheduler bin-packs on it and
  // keeps heavy tiers off the prod-co-located node. Reused below for the boot payload.
  let changeVerifyTier: string | null = null;
  if (opts.changeId) {
    changeVerifyTier = (await db.select({ verifyTier: changes.verifyTier }).from(changes).where(eq(changes.id, opts.changeId)).limit(1))[0]?.verifyTier ?? null;
  }

  // Per-agent serialization: the in-flight + rate-cap check + insert is atomic so
  // two concurrent ticks can't both create a run. `withChangeUpsertLock` takes a
  // Postgres advisory lock keyed on (sa.id|"standing") inside a transaction.
  // v3 P4 — coalesce-to-latest lease key. Stamped as the run's concurrency
  // group so the existing running-group index + newest-wins promotion apply;
  // same-(group, commit) requests dedupe; stale pending siblings collapse.
  const leaseGroup = agentRunGroup(sa, targetRepoId, opts.changeId ?? null);
  const leaseCommit = opts.commit ?? target.commit;

  type Outcome = { kind: "ok"; run: typeof ciRuns.$inferSelect } | { kind: "in_flight" } | { kind: "rate_capped" } | { kind: "duplicate" };
  let outcome: Outcome;
  try {
    outcome = await withChangeUpsertLock(db, sa.id, "standing", async tx => {
      // Same-version dedup: an identical live request (same group + commit)
      // makes this dispatch a no-op — never a queue behind itself.
      if (await hasLiveRunForVersion(tx, leaseGroup, leaseCommit)) return { kind: "duplicate" } as Outcome;
      // Newest wins: pending work about an OLDER version is superseded.
      await collapseStalePending(tx, leaseGroup, leaseCommit);
      if (await hasRunInFlight(tx, sa.id)) return { kind: "in_flight" } as Outcome;
      // Per-agent backstop: bounds ANY loop shape (tiny interval, event
      // self-trigger, manual spam) independent of how it forms.
      if (!withinStandingRateCap(await recentRunCount(tx, sa.id))) return { kind: "rate_capped" } as Outcome;
      const runnerToken = randomToken(18);
      const [run] = await tx.insert(ciRuns).values({
        repoId: targetRepoId, standingAgentId: sa.id, runnerToken, origin: "agent",
        runsOn: sa.image.endsWith(":local") ? "arm64" : null,
        // A verify/review tick triggered by a change event binds to that change's
        // EXACT head (passed by the dispatcher) — verified autonomy keys off
        // run.commit === change.headCommit. Other ticks target default-branch HEAD.
        commit: opts.commit ?? target.commit,
        // changeId links a change-scoped run to its change (recomputeChangeCiStatus
        // still ignores pipeline-less runs, so this never votes on CI). Else null.
        changeId: opts.changeId ?? null,
        // Per-run activation payload (manual tick): an ad-hoc task and/or a specific
        // issue to point an idle agent at, surfaced as CLAWHUB_TASK / CLAWHUB_ISSUE.
        dispatchTask: opts.task ?? null,
        dispatchIssue: opts.issue ?? null,
        // Per-run model override (M4 native reviewer: model selected per-change).
        dispatchModel: opts.model ?? null,
        // v3 P4: coalesce lease group + the asking human (slash command / Run now).
        concurrencyGroup: leaseGroup,
        triggeredByUserId: opts.triggeredByUserId ?? null,
        // v4: the workflow that dispatched this run — its activity history.
        workflowId: opts.workflowId ?? null,
        // Unified scheduler stamp (docs/job-scheduler-design.md): priority band from
        // the agent's mode, resource request from its limits + the verify tier, and a
        // retry budget for TRANSIENT (stuck/preempted) failures.
        priorityClass: agentPriorityClass(sa.mode),
        resourceRequest: agentResourceRequest(sa, changeVerifyTier),
        maxAttempts: defaultMaxAttempts("agent"),
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

  if (outcome.kind === "duplicate") {
    metrics.inc("clawhub_standing_dispatch_total", { outcome: "duplicate" });
    return { ok: false, reason: "duplicate" };
  }
  if (outcome.kind === "in_flight") return { ok: false, reason: "in_flight" };
  if (outcome.kind === "rate_capped") {
    log("warn", "standing_rate_capped", { id: sa.id, cap: STANDING_RATE_CAP });
    await markStatus(db, sa.id, "error", `rate cap reached (${STANDING_RATE_CAP}/${STANDING_RATE_WINDOW_MS / 60000}m)`);
    metrics.inc("clawhub_standing_dispatch_total", { outcome: "rate_capped" });
    return { ok: false, reason: "rate_capped" };
  }

  // changeVerifyTier was resolved up front (before the insert) so it could size the
  // run's persisted resource request; reuse it for the harness boot payload.
  await events.publish({
    type: "ci.run.queued",
    repoId: targetRepoId,
    actorKind: "system",
    actorId: "standing-agent",
    payload: queuedPayload(sa, target, outcome.run, changeVerifyTier),
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
// When this API process booted. A deploy restarts the process, so a run that
// FAILS within INFRA_ABORT_WINDOW of boot was almost certainly killed by the
// deploy (mid-flight when the box bounced), NOT by a real agent fault — it must
// not push the agent toward the circuit breaker. Best-effort deploy-abort guard.
const PROCESS_BOOT_MS = Date.now();
const INFRA_ABORT_WINDOW_MS = Number(process.env.CLAWHUB_INFRA_ABORT_WINDOW_MS ?? 120_000);

export async function recordStandingRunResult(db: DB, standingAgentId: string, runId: string, outcome: "success" | "failure", note?: string, now: Date = new Date()): Promise<void> {
  // Infra-abort: a failure right after a deploy is not the agent's fault. Both
  // callers (ci-runner terminal + reaper) have ALREADY set the run terminal, so a
  // bare no-op would DROP the run forever — the re-publisher only re-publishes
  // PENDING runs. Reset it to pending (CAS off a terminal status) so
  // republishStalePendingStandingRuns re-dispatches the work the deploy killed.
  if (outcome === "failure" && now.getTime() - PROCESS_BOOT_MS < INFRA_ABORT_WINDOW_MS) {
    metrics.inc("clawhub_standing_runs_total", { outcome: "failure_infra_abort" });
    log("info", "standing_run_infra_abort", { id: standingAgentId, runId, sinceBootMs: now.getTime() - PROCESS_BOOT_MS });
    try {
      await db.update(ciRuns).set({ status: "pending", startedAt: null, finishedAt: null, stepResults: [] })
        .where(and(eq(ciRuns.id, runId), inArray(ciRuns.status, ["failure", "success", "skipped"])));
    } catch (e) {
      // 23505: another PENDING run for this agent already exists (partial unique
      // index) → it will cover the work; leave this one terminal.
      if ((e as { code?: string }).code !== "23505") log("warn", "infra_abort_requeue_failed", { runId, err: (e as Error).message });
    }
    return;
  }
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
export async function standingRunEnv(db: DB, run: { id: string; standingAgentId: string | null; commit: string | null; repoId: string; changeId?: string | null; dispatchTask?: string | null; dispatchIssue?: number | null; dispatchModel?: string | null }, clawhubUrl: string): Promise<Record<string, string> | null> {
  if (!run.standingAgentId) return null;
  const sa = (await db.select().from(standingAgents).where(eq(standingAgents.id, run.standingAgentId)).limit(1))[0];
  if (!sa) return null;
  // v4: the RUN row carries the dispatch-resolved repo (a global deployment
  // has sa.repoId null) — always resolve the target from the run.
  const target = await resolveRepoTarget(db, run.repoId);
  const repo = target ? `${target.ns}/${target.repoName}` : "";
  let token = "";
  try { token = unseal(sa.tokenCiphertext, sa.tokenNonce); } catch { /* sealing key changed; token unrecoverable */ }
  let llmKey: string | null = null;
  if (sa.llmCiphertext && sa.llmNonce) { try { llmKey = unseal(sa.llmCiphertext, sa.llmNonce); } catch { llmKey = null; } }
  // keySource='platform' (M3/M4): route the container through the metering gateway
  // instead of injecting a raw key. Mint a per-run gateway token NOW (the run is
  // claimed + running when the runner pulls secrets, so this is the last moment
  // before the container boots); its hash is pinned to the run and it dies at
  // run-terminal. The real platform key never leaves the API process.
  let platformGateway: { baseUrl: string; token: string } | null = null;
  if (sa.keySource === "platform") {
    const gwToken = await mintGatewayToken(db, run.id);
    // Pick the gateway PROTOCOL by the agent's provider: an OpenAI-shaped provider
    // (OpenRouter, D8) routes through /openai/v1 (OPENAI_BASE_URL expects the /v1
    // suffix so the CLI appends /chat/completions); Anthropic stays on /anthropic.
    const base = clawhubUrl.replace(/\/+$/, "");
    const openAiProto = sa.llmProvider === "openai" || sa.llmProvider === "openrouter";
    platformGateway = { baseUrl: openAiProto ? `${base}/api/v1/llm/openai/v1` : `${base}/api/v1/llm/anthropic`, token: gwToken };
  }
  // A change-pinned run (verify/review on change.opened) knows exactly which files
  // it is about: the Change's authoritative changedPaths (computed at post-push).
  // Conditioning the pack on them lights the path + graph ranking legs, so the run
  // boots with memories about THIS diff instead of a generic importance top-N.
  let changedPaths: string[] | undefined;
  // Conformance-verify spec (M5): a verify run gets the resolved behavior spec
  // (issue → description → inferred) + its basis, so the verifier can check the
  // Change AGAINST a contract (both directions) instead of only describing it.
  // Best-effort, capped at 16KB — like the memory pack.
  let specEnv: { spec: string; basis: string } | undefined;
  // Plan-then-playback (M6): if this verify run's change has a FRESH plan (same
  // paths/spec/tier), inject the scripted steps so the harness REPLAYS them with
  // zero model tokens. Stale/absent → no steps → a full model verify authors a
  // new plan. `CLAWHUB_VERIFY_STEPS` present = the metering `playback:true` path.
  let playbackSteps: string | undefined;
  if (run.changeId) {
    const ch = (await db.select({ id: changes.id, intent: changes.intent, description: changes.description, branch: changes.branch, changedPaths: changes.changedPaths, verifyTier: changes.verifyTier }).from(changes).where(eq(changes.id, run.changeId)).limit(1))[0];
    const paths = ch?.changedPaths;
    if (Array.isArray(paths)) changedPaths = paths.filter((p): p is string => typeof p === "string").slice(0, 200);
    if (ch && sa.mode === "verify") {
      try {
        const resolved = await resolveSpec(db, ch);
        specEnv = { spec: resolved.spec.slice(0, 16_384), basis: resolved.basis };
        const plan = await loadActiveVerifyPlan(db, ch.id);
        if (plan) {
          const anchors = await currentPlanAnchors(db, ch);
          if (!isPlanStale(plan, anchors)) playbackSteps = JSON.stringify({ steps: plan.steps, checkMap: plan.checkMap, planId: plan.id });
        }
      } catch (e) { log("warn", "standing_spec_resolve_failed", { id: sa.id, err: (e as Error).message }); }
    }
  }
  // Pre-retrieve the memory pack for this run (best-effort — memory is additive,
  // a failure here must not block the run). Scoped to (this agent, this repo).
  let memoryPack: string | undefined;
  try {
    const ids = await resolveScopeIds(db, sa.agentId, run.repoId);
    memoryPack = await buildMemoryPack(db, ids, { changedPaths });
  } catch (e) { log("warn", "standing_memory_pack_failed", { id: sa.id, err: (e as Error).message }); }
  const env = buildStandingEnv({
    // A per-run model override (M4) beats the row's model — surfaced as CLAWHUB_MODEL.
    sa: run.dispatchModel ? { ...sa, model: run.dispatchModel } : sa,
    clawhubUrl,
    repo,
    commit: run.commit ?? target?.commit ?? "",
    token,
    llmKey,
    runId: run.id,
    memoryPack,
    taskOverride: run.dispatchTask ?? null,
    issue: run.dispatchIssue ?? null,
    changeId: run.changeId ?? null,
    platformGateway,
  });
  // v2 agents-ux: per-agent MODEL INTELLIGENCE (skills + MCP servers) rides in
  // as fenced JSON; the harness materializes it for whichever CLI/API loop runs
  // (skills → .claude/skills + a prompt block; MCP → .mcp.json). Capped 32KB.
  try {
    const agentRow = (await db.select({ intelligence: agents.intelligence }).from(agents).where(eq(agents.id, sa.agentId)).limit(1))[0];
    if (agentRow?.intelligence) {
      const packed = JSON.stringify(agentRow.intelligence);
      if (packed.length > 2 && packed.length <= 32_768) env.CLAWHUB_INTELLIGENCE = packed;
    }
  } catch (e) { log("warn", "standing_intelligence_load_failed", { id: sa.id, err: (e as Error).message }); }
  // The verifier reads CLAWHUB_SPEC (the behavior contract to check both directions)
  // + CLAWHUB_SPEC_BASIS (so it knows whether it's conforming to an authored spec or
  // an inferred one). Empty spec (inferred) still sets the basis.
  if (specEnv) { if (specEnv.spec) env.CLAWHUB_SPEC = specEnv.spec; env.CLAWHUB_SPEC_BASIS = specEnv.basis; }
  // A fresh plan → the harness replays it (zero model tokens); its presence is the
  // playback discriminator the biller keys on.
  if (playbackSteps) { env.CLAWHUB_VERIFY_STEPS = playbackSteps; env.CLAWHUB_VERIFY_PLAYBACK = "1"; }
  return env;
}
