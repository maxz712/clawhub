import { describe, it, expect } from "vitest";
import {
  validateStandingConfig, standingLlmEnv, buildStandingEnv, withinStandingRateCap,
  continuousDue, redactStanding, STANDING_RATE_CAP, MIN_INTERVAL_SEC,
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
  it("enforces the continuous interval floor", () => {
    expect(() => validateStandingConfig({ intervalSec: MIN_INTERVAL_SEC - 1 })).toThrow(/intervalSec/);
    expect(() => validateStandingConfig({ intervalSec: MIN_INTERVAL_SEC })).not.toThrow();
  });
  it("rejects unknown triggers + providers", () => {
    expect(() => validateStandingConfig({ trigger: "forever" })).toThrow(/trigger/);
    expect(() => validateStandingConfig({ llmProvider: "gpt5" })).toThrow(/llmProvider/);
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
