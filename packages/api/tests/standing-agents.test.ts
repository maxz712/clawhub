import { describe, it, expect } from "vitest";
import {
  validateStandingConfig, standingLlmEnv, buildStandingEnv, withinStandingRateCap,
  continuousDue, redactStanding, computeFailureState, STANDING_RATE_CAP, MIN_INTERVAL_SEC,
  STANDING_MAX_CONSECUTIVE_FAILURES,
} from "../src/services/standing-agents.js";
import type { StandingAgent } from "../src/models/schema.js";

// ---------------------------------------------------------------------------
// Validation — the config gate that keeps an unrunnable trigger from being saved.
// ---------------------------------------------------------------------------
describe("validateStandingConfig", () => {
  it("accepts a well-formed continuous config", () => {
    expect(() => validateStandingConfig({ trigger: "continuous", intervalSec: 3600, llmProvider: "anthropic", image: "img", name: "bot" })).not.toThrow();
  });
  it("requires a cron for schedule triggers", () => {
    expect(() => validateStandingConfig({ trigger: "schedule" })).toThrow(/cron/);
    expect(() => validateStandingConfig({ trigger: "schedule", cron: "0 9 * * 1" })).not.toThrow();
  });
  it("requires an event type for event triggers", () => {
    expect(() => validateStandingConfig({ trigger: "event" })).toThrow(/event/);
    expect(() => validateStandingConfig({ trigger: "event", event: "change.merged" })).not.toThrow();
  });
  it("rejects an unparseable cron (else a schedule agent silently never fires)", () => {
    expect(() => validateStandingConfig({ trigger: "schedule", cron: "* * * *" })).toThrow(/cron/);   // 4 fields
    expect(() => validateStandingConfig({ trigger: "schedule", cron: "99 * * * *" })).toThrow(/cron/); // out of range
    expect(() => validateStandingConfig({ trigger: "schedule", cron: "0 9 * * 1" })).not.toThrow();
  });
  it("bounds operator-supplied resource limits", () => {
    expect(() => validateStandingConfig({ memoryMb: 0 })).toThrow(/memoryMb/);
    expect(() => validateStandingConfig({ memoryMb: 999999 })).toThrow(/memoryMb/);
    expect(() => validateStandingConfig({ cpus: 0 })).toThrow(/cpus/);
    expect(() => validateStandingConfig({ timeoutSec: 10 ** 9 })).toThrow(/timeoutSec/);
    expect(() => validateStandingConfig({ memoryMb: 1024, cpus: 2, timeoutSec: 1800 })).not.toThrow();
  });
  it("enforces the continuous interval floor", () => {
    expect(() => validateStandingConfig({ intervalSec: MIN_INTERVAL_SEC - 1 })).toThrow(/intervalSec/);
    expect(() => validateStandingConfig({ intervalSec: MIN_INTERVAL_SEC })).not.toThrow();
  });
  it("rejects unknown triggers + providers", () => {
    expect(() => validateStandingConfig({ trigger: "forever" })).toThrow(/trigger/);
    expect(() => validateStandingConfig({ llmProvider: "gpt5" })).toThrow(/llmProvider/);
  });
  it("accepts the known CLIs and rejects an unknown one", () => {
    for (const cli of ["claude", "copilot", "codex", "gemini"]) {
      expect(() => validateStandingConfig({ cli })).not.toThrow();
    }
    expect(() => validateStandingConfig({ cli: "cursor" })).toThrow(/cli/);
  });
  it("rejects a bad name", () => {
    expect(() => validateStandingConfig({ name: "has spaces" })).toThrow(/name/);
  });
});

// ---------------------------------------------------------------------------
// LLM env mapping — the BYO-credential plumbing. Each provider maps the generic
// key onto the conventional env var plus a generic mirror, and a missing key
// injects no key var (local no-auth model).
// ---------------------------------------------------------------------------
describe("standingLlmEnv", () => {
  it("maps an anthropic key + base url", () => {
    const e = standingLlmEnv("anthropic", "https://proxy.local", "sk-ant-123");
    expect(e.ANTHROPIC_API_KEY).toBe("sk-ant-123");
    expect(e.ANTHROPIC_BASE_URL).toBe("https://proxy.local");
    expect(e.LLM_PROVIDER).toBe("anthropic");
    expect(e.LLM_API_KEY).toBe("sk-ant-123");
  });
  it("defaults the openrouter base url", () => {
    const e = standingLlmEnv("openrouter", null, "or-123");
    expect(e.OPENROUTER_API_KEY).toBe("or-123");
    expect(e.LLM_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });
  it("maps an openai key + optional base url", () => {
    const e = standingLlmEnv("openai", "https://oai.local", "oa-1");
    expect(e.OPENAI_API_KEY).toBe("oa-1");
    expect(e.OPENAI_BASE_URL).toBe("https://oai.local");
  });
  it("a custom provider uses the generic vars", () => {
    const e = standingLlmEnv("custom", "http://localhost:8080", "k");
    expect(e.LLM_API_KEY).toBe("k");
    expect(e.LLM_BASE_URL).toBe("http://localhost:8080");
  });
  it("injects no key var when the key is empty (local no-auth model)", () => {
    const e = standingLlmEnv("custom", "http://localhost:1234", "");
    expect(e.LLM_API_KEY).toBeUndefined();
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.LLM_BASE_URL).toBe("http://localhost:1234");
  });
});

// ---------------------------------------------------------------------------
// CLI selection — orthogonal to the LLM provider. The harness reads CLAWHUB_CLI
// and the single sealed key is injected under whatever env var that CLI reads.
// ---------------------------------------------------------------------------
describe("standingLlmEnv — CLAWHUB_CLI mapping", () => {
  it("defaults to claude (legacy back-compat: ANTHROPIC_API_KEY unchanged)", () => {
    const e = standingLlmEnv("anthropic", null, "sk-ant-x"); // no cli arg
    expect(e.CLAWHUB_CLI).toBe("claude");
    expect(e.ANTHROPIC_API_KEY).toBe("sk-ant-x");
  });
  it("codex → OPENAI_API_KEY", () => {
    const e = standingLlmEnv("openai", null, "oa-1", "codex");
    expect(e.CLAWHUB_CLI).toBe("codex");
    expect(e.OPENAI_API_KEY).toBe("oa-1");
  });
  it("gemini → GEMINI_API_KEY + GOOGLE_API_KEY", () => {
    const e = standingLlmEnv("custom", null, "g-1", "gemini");
    expect(e.CLAWHUB_CLI).toBe("gemini");
    expect(e.GEMINI_API_KEY).toBe("g-1");
    expect(e.GOOGLE_API_KEY).toBe("g-1");
  });
  it("copilot → GITHUB_TOKEN + GH_TOKEN", () => {
    const e = standingLlmEnv("custom", null, "ghp_x", "copilot");
    expect(e.CLAWHUB_CLI).toBe("copilot");
    expect(e.GITHUB_TOKEN).toBe("ghp_x");
    expect(e.GH_TOKEN).toBe("ghp_x");
  });
  it("the CLI key var is set even when the provider differs (CLI ≠ backend)", () => {
    // provider stays anthropic (e.g. base-url routing) but the CLI is codex.
    const e = standingLlmEnv("anthropic", null, "k", "codex");
    expect(e.OPENAI_API_KEY).toBe("k");
  });
  it("an unknown cli falls back to claude", () => {
    const e = standingLlmEnv("anthropic", null, "k", "cursor");
    expect(e.CLAWHUB_CLI).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// Full container env — ClawHub context + push token + LLM creds.
// ---------------------------------------------------------------------------
describe("buildStandingEnv", () => {
  it("includes the ClawHub context + token + task + LLM key", () => {
    const env = buildStandingEnv({
      sa: { id: "sa1", llmProvider: "anthropic", llmBaseUrl: null, task: "fix tests" },
      clawhubUrl: "https://useclawhub.com", repo: "alice/demo", commit: "abc123",
      token: "agent-jwt", llmKey: "sk-ant-x",
    });
    expect(env.CLAWHUB_URL).toBe("https://useclawhub.com");
    expect(env.CLAWHUB_TOKEN).toBe("agent-jwt");
    expect(env.CLAWHUB_REPO).toBe("alice/demo");
    expect(env.CLAWHUB_COMMIT).toBe("abc123");
    expect(env.CLAWHUB_TASK).toBe("fix tests");
    expect(env.CLAWHUB_STANDING_AGENT_ID).toBe("sa1");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
    expect(env.CLAWHUB_CLI).toBe("claude"); // no cli on the row → default
  });
  it("propagates the selected CLI + injects the key under that CLI's var", () => {
    const env = buildStandingEnv({
      sa: { id: "sa2", llmProvider: "custom", llmBaseUrl: null, task: "verify", mode: "verify", cli: "codex" },
      clawhubUrl: "https://useclawhub.com", repo: "alice/demo", commit: "abc123",
      token: "agent-jwt", llmKey: "oa-key",
    });
    expect(env.CLAWHUB_CLI).toBe("codex");
    expect(env.CLAWHUB_MODE).toBe("verify");
    expect(env.OPENAI_API_KEY).toBe("oa-key");
  });
});

// ---------------------------------------------------------------------------
// Rate cap + continuous timing (the loop-guard timing pieces).
// ---------------------------------------------------------------------------
describe("withinStandingRateCap", () => {
  it("bounds dispatches at the cap", () => {
    expect(withinStandingRateCap(STANDING_RATE_CAP - 1)).toBe(true);
    expect(withinStandingRateCap(STANDING_RATE_CAP)).toBe(false);
    expect(withinStandingRateCap(STANDING_RATE_CAP + 100)).toBe(false);
  });
});

describe("continuousDue", () => {
  const now = new Date(Date.UTC(2026, 5, 19, 12, 0, 0));
  it("is due when never run", () => {
    expect(continuousDue(null, 3600, now)).toBe(true);
  });
  it("is due once the interval has elapsed", () => {
    const oneHourAgo = new Date(now.getTime() - 3600_000);
    expect(continuousDue(oneHourAgo, 3600, now)).toBe(true);
    const halfHourAgo = new Date(now.getTime() - 1800_000);
    expect(continuousDue(halfHourAgo, 3600, now)).toBe(false);
  });
  it("is held off while a failure-backoff hold is active", () => {
    const longAgo = new Date(now.getTime() - 10 * 3600_000); // interval long elapsed
    const future = new Date(now.getTime() + 600_000);        // backoff hold not yet passed
    expect(continuousDue(longAgo, 3600, now, future)).toBe(false);
    const past = new Date(now.getTime() - 1);                // hold elapsed
    expect(continuousDue(longAgo, 3600, now, past)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure backoff + circuit breaker — the robustness core for agent loops.
// ---------------------------------------------------------------------------
describe("computeFailureState", () => {
  const now = new Date(Date.UTC(2026, 5, 19, 12, 0, 0));
  it("resets everything on success", () => {
    const s = computeFailureState(4, 3600, now, "success");
    expect(s.status).toBe("idle");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.nextEligibleAt).toBeNull();
    expect(s.lastError).toBeNull();
    expect(s.enabled).toBeUndefined(); // doesn't touch enabled on success
  });
  it("increments + sets an exponential backoff hold on failure", () => {
    const s1 = computeFailureState(0, 100, now, "failure");
    expect(s1.consecutiveFailures).toBe(1);
    expect(s1.status).toBe("error");
    expect(s1.enabled).toBeUndefined(); // not yet tripped
    // failures=1 → backoff 100s * 2^1 = 200s
    expect(s1.nextEligibleAt!.getTime()).toBe(now.getTime() + 200_000);
    const s2 = computeFailureState(1, 100, now, "failure");
    expect(s2.nextEligibleAt!.getTime()).toBe(now.getTime() + 400_000); // 2^2
  });
  it("trips the circuit breaker (auto-pause) at the failure ceiling", () => {
    const s = computeFailureState(STANDING_MAX_CONSECUTIVE_FAILURES - 1, 3600, now, "failure", "kept crashing");
    expect(s.consecutiveFailures).toBe(STANDING_MAX_CONSECUTIVE_FAILURES);
    expect(s.enabled).toBe(false);       // auto-paused
    expect(s.nextEligibleAt).toBeNull(); // no backoff hold once paused
    expect(s.lastError).toMatch(/auto-paused/);
  });
});

// ---------------------------------------------------------------------------
// Redaction — the API must NEVER return the sealed token or LLM key.
// ---------------------------------------------------------------------------
describe("redactStanding", () => {
  it("strips sealed credentials and exposes only hasLlmKey", () => {
    const sa = {
      id: "sa1", repoId: "r", agentId: "a", name: "bot", image: "img", command: null,
      trigger: "continuous", cron: null, event: null, intervalSec: 3600, task: "",
      llmProvider: "anthropic", llmBaseUrl: null,
      llmCiphertext: "SEALED-LLM", llmNonce: "n1",
      tokenCiphertext: "SEALED-TOKEN", tokenNonce: "n2",
      memoryMb: 1024, cpus: 1, timeoutSec: 1800, enabled: true, status: "idle",
      lastError: null, lastRunId: null, lastRunAt: null, lastScheduledAt: null,
      createdByUserId: null, createdAt: new Date(),
    } as unknown as StandingAgent;
    const red = redactStanding(sa) as Record<string, unknown>;
    expect(red.tokenCiphertext).toBeUndefined();
    expect(red.tokenNonce).toBeUndefined();
    expect(red.llmCiphertext).toBeUndefined();
    expect(red.llmNonce).toBeUndefined();
    expect(red.hasLlmKey).toBe(true);
    // A real value that must survive redaction.
    expect(red.name).toBe("bot");
    // Ensure no sealed material leaks through any other key.
    expect(JSON.stringify(red)).not.toContain("SEALED");
  });
});
