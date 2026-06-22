// The operator runner allowlist: agent ids (comma-separated in
// CLAWHUB_RUNNER_AGENT_IDS) that constitute the shared CI/standing-agent runner
// pool. ONE source of truth used by both the SSE run-dispatch gate (routes/
// events.ts) and the secrets-pull gate (routes/ci.ts).
//
// Read lazily (per call) rather than memoized at import so tests — and a process
// that sets the env after boot — observe the current value. In production the
// env is fixed at boot, so the cost is a trivial string split.
export function runnerAgentIds(): Set<string> {
  return new Set((process.env.CLAWHUB_RUNNER_AGENT_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean));
}

/** True when an operator has configured a runner-agent allowlist (multi-tenant pool). */
export function runnerAllowlistConfigured(): boolean {
  return runnerAgentIds().size > 0;
}

export function isAllowlistedRunner(agentId: string): boolean {
  return runnerAgentIds().has(agentId);
}
