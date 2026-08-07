"use strict";
/**
 * Which hosts a sandboxed run may reach regardless of its egress policy — and,
 * crucially, WHICH OF THOSE are trusted enough to skip the private-IP guard.
 *
 * Split into two tiers because the single old list mixed operator-controlled and
 * TENANT-controlled input (#131 leg 2). Repo CI secrets are named verbatim by
 * whoever holds repo write, so a secret called `X_BASE_URL=http://169.254.169.254`
 * used to land in the guard-exempt list and hand its own CI a self-service
 * exemption from the SSRF guard — under every policy, including `egress: none`.
 *
 *   HARD infra (EGRESS_INFRA)      — reachable under every policy AND exempt from
 *     the private-IP guard. Derived ONLY from the runner's own env, which is
 *     operator config: `CLAWHUB_URL` (the API this runner serves) plus the
 *     explicit `CLAWHUB_RUNNER_INFRA_HOSTS` escape hatch. The exemption exists so
 *     a single-box self-host, whose API answers on a private address, still works.
 *
 *   SOFT infra (EGRESS_SOFT_INFRA) — reachable under every policy but STILL
 *     subject to the private-IP guard. Everything derived from the secrets bag
 *     (the agent's `CLAWHUB_URL`, any `*_BASE_URL`) plus the well-known LLM
 *     provider domains. A BYO agent's custom gateway keeps working under
 *     `egress: none`; pointing one at loopback/metadata does not.
 *
 * Consumed by src/index.ts and enforced in egress-proxy.cjs. Plain CJS with no
 * imports so the tests can require it directly — same pattern as janitor-rules.cjs.
 */

const net = require("node:net");

/**
 * Extract the bare hostname from a URL, a `host[:port]`, or a bare IP literal.
 *
 * A bare IPv6 literal needs bracketing before `new URL()` will look at it —
 * without that step `hostOf("fd00::1")` throws and returns null SILENTLY, which
 * would make the `CLAWHUB_RUNNER_INFRA_HOSTS` escape hatch a no-op for exactly
 * the operator who spells their infra address the natural way.
 */
function hostOf(u) {
  if (!u) return null;
  const raw = String(u).trim();
  if (net.isIPv6(raw)) return raw.toLowerCase();
  try { return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, ""); }
  catch { return null; }
}

// The union of common AI provider/aggregator API hosts + the auth/telemetry/
// control-plane hosts the baked-in coding-agent CLIs use. Reachable under any
// policy as SOFT infra so a BYO agent on ANY provider works with just its key.
// Bare domains where per-account/regional subdomains exist. Researched 2026-06;
// see docs/agent-providers.md. (registry.npmjs.org/pypi.org/docker.all-hands.dev
// are install/runtime hosts — kept so a CLI's self-update / a pip/npm step works.)
const AI_PROVIDER_HOSTS = [
  // First-party LLM APIs
  "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com", "api.mistral.ai", "api.cohere.com", "api.cohere.ai",
  "api.groq.com", "api.together.xyz", "api.together.ai", "api.fireworks.ai",
  "api.deepseek.com", "api.x.ai", "accounts.x.ai", "api.perplexity.ai",
  "api.cerebras.ai", "api.hyperbolic.xyz", "integrate.api.nvidia.com",
  "api.endpoints.anyscale.com",
  // Cloud-provider model gateways (bare domains for regional/per-resource subdomains)
  "openai.azure.com", "cognitiveservices.azure.com", "services.ai.azure.com",
  "amazonaws.com", "bedrock-runtime.amazonaws.com", "bedrock.amazonaws.com",
  // Aggregators / gateways
  "openrouter.ai", "helicone.ai", "oai.helicone.ai", "gateway.helicone.ai",
  "ai-gateway.helicone.ai", "portkey.ai", "api.portkey.ai", "requesty.ai",
  "router.requesty.ai", "router.eu.requesty.ai", "gateway.ai.cloudflare.com",
  // Agent-CLI brokers + control planes
  "api.cline.bot", "api.continue.dev", "api2.cursor.sh", "api.cursor.com", "cursor.com",
  "githubcopilot.com", "api.githubcopilot.com", "api.github.com", "github.com",
  // CLI auth / telemetry / OAuth paths
  "auth.openai.com", "chatgpt.com", "statsig.anthropic.com", "sentry.io",
  "oauth2.googleapis.com", "accounts.google.com", "cloudcode-pa.googleapis.com",
  "play.googleapis.com",
  // Install / runtime registries (so npm/pip self-update + runtime pulls work)
  "registry.npmjs.org", "pypi.org", "docker.all-hands.dev",
];

/**
 * OPERATOR-trusted hosts: reachable under every policy and exempt from the
 * private-IP guard. Every input is operator config — `baseUrl` is the API this
 * runner clones from, `env` is the runner process env, and `serverBuiltSecrets`
 * is a bag the API AUTHORED rather than one the tenant named (see below). The
 * run payload and the repo's CI secrets never reach this list.
 */
function deriveInfraHosts({ baseUrl, env = process.env, serverBuiltSecrets = null } = {}) {
  const hosts = new Set();
  const add = h => { if (h) hosts.add(h); };
  add(hostOf(baseUrl));
  // Escape hatch for an operator whose infra genuinely lives on more private
  // addresses than the API (a LAN model server, an internal registry). This is
  // runner config — the same trust boundary as CLAWHUB_URL.
  for (const h of String(env.CLAWHUB_RUNNER_INFRA_HOSTS || "").split(",")) add(hostOf(h.trim()));
  // A STANDING run's env is built ENTIRELY by the API (standingRunEnv), so its
  // CLAWHUB_URL is the operator's CLAWHUB_PUBLIC_URL — not a tenant-authored
  // secret — and it keeps the exemption a self-host on a private address needs
  // when the API's public URL differs from the one the runner clones from. A
  // PIPELINE run's bag is decryptRepoSecrets, where the tenant names every key,
  // so it is never passed here.
  if (serverBuiltSecrets) add(hostOf(serverBuiltSecrets.CLAWHUB_URL));
  return [...hosts];
}

/**
 * Hosts reachable under every policy but STILL private-IP-guarded. Derived from
 * the (tenant-nameable) secrets bag plus the static provider domains, so nothing
 * here can grant itself an exemption from the SSRF guard.
 */
function deriveSoftInfraHosts(secrets = {}) {
  const hosts = new Set();
  const add = h => { if (h) hosts.add(h); };
  add(hostOf(secrets.CLAWHUB_URL));  // the URL the agent pushes to (may differ from the runner's)
  for (const [k, v] of Object.entries(secrets)) if (/BASE_URL$/i.test(k)) add(hostOf(v));
  for (const d of AI_PROVIDER_HOSTS) hosts.add(d);
  return [...hosts];
}

module.exports = { hostOf, AI_PROVIDER_HOSTS, deriveInfraHosts, deriveSoftInfraHosts };
