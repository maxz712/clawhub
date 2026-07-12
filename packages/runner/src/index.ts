#!/usr/bin/env node
/**
 * ClawHub CI runner — subscribes to webhook deliveries for `ci.run.queued`
 * events, clones the repo, runs pipeline steps (shell or docker), and reports
 * status back via the public runner callback API.
 *
 * Env:
 *   CLAWHUB_URL          — base URL
 *   CLAWHUB_TOKEN        — agent JWT (for cloning)
 *   CLAWHUB_RUNNER_POLL  — webhook URL we're subscribed to (we poll via SSE)
 *   CLAWHUB_RUNNER_WORKDIR — where to clone/run (default /tmp/clawhub-runner)
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm, chmod, copyFile } from "node:fs/promises";
import { acquireServices, releaseServices, type AcquiredServices } from "./service-pool.js";
import path from "node:path";
import { tmpdir, loadavg, freemem, totalmem, hostname, cpus as osCpus } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const BASE = (process.env.CLAWHUB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.CLAWHUB_TOKEN ?? "";
const WORKROOT = process.env.CLAWHUB_RUNNER_WORKDIR ?? path.join(tmpdir(), "clawhub-runner");

interface QueuedRun {
  runId: string;
  repoNs: string;
  repoName: string;
  commit: string;
  // Arch pin from a pipeline `runs_on:` — this run executes ONLY on a runner whose
  // process.arch matches (amd64/x86_64 ↔ x64, arm64/aarch64 ↔ arm64). Absent = any
  // runner may claim (default, fail-safe). Powers a native multi-arch build matrix
  // (arm64 job on the arm64 runner, amd64 job on the amd64 runner — no QEMU).
  runsOn?: string;
  // Capability-graded execution, STAMPED BY THE SERVER (services/ci-host-exec.ts) — the
  // runner NEVER reads execution from the pipeline YAML. "host" = run CI steps directly on
  // the runner host with full env (deploy/build; granted only to an operator-allowlisted
  // repo). Anything else, incl. ABSENT = the contained sandbox (fail-closed default): steps
  // run in a per-run container with NO host access and NO runner env — so another repo's CI
  // physically cannot touch the host, docker, sibling workdirs, or this runner's token.
  // "host" = run the pipeline's YAML steps on the host (general host shell — allowlisted only).
  // "deploy" = run ONLY the fixed reviewed entrypoint scripts/self-deploy.sh, NEVER the YAML
  // (a narrower, un-injectable host act: restart the box's own stack). "build" = run the steps
  // in a CONTAINED rootless-BuildKit sandbox (build images without host docker — a slightly
  // relaxed-seccomp tier, so allowlisted-only). Anything else / ABSENT = contained sandbox.
  execution?: "host" | "deploy" | "build" | "sandbox";
  // Set when the run targets a specific Change (verify/review on change.opened).
  // The Change head usually lives ONLY on a Change ref (refs/changes/<id> or
  // refs/clawhub/changes/<id>) that a clone does not fetch, so the runner fetches
  // that ref by id before checkout. See runOne.
  changeId?: string;
  // Docker-in-Docker: true ONLY for the `dind` verification tier — a multi-service
  // app that needs its own Docker daemon. The container then runs `--privileged` so
  // it can start a nested dockerd and `docker compose up`. The cheaper tiers
  // (static/app/services) run NON-privileged. The nested stack stays INSIDE this
  // container and its egress still routes through the per-run proxy, so containment
  // holds. See runContainer + docs/verified-autonomy.md.
  dind?: boolean;
  // The verification tier the harness boots: static|app|services|dind. Forwarded to
  // the container as CLAWHUB_VERIFY_TIER. Server-derived (verify-tier.ts) — the cheap
  // tiers are the default; dind is the opt-in heavy fallback.
  verifyTier?: string;
  pipelineYaml: string;
  runnerToken: string;
  // Standing-agent runs carry an image instead of pipeline steps: the runner runs
  // the BYO container WITH network (to reach an LLM) and the injected agent token
  // + LLM creds (pulled from the gated secrets endpoint). See docs/standing-agents.md.
  standing?: boolean;
  // Review-only (M4 native reviewer): the container never executes repo code — it
  // reads the diff via the API — so the runner SKIPS THE CLONE entirely. No repo
  // code enters a review-only container. Server-stamped; the runner obeys it.
  reviewOnly?: boolean;
  image?: string;
  command?: string;
  timeoutSec?: number;
  memoryMb?: number;
  cpus?: number;
  // Network containment for the BYO container (browser + LLM + push all flow
  // through this). policy: none = infra-only (ClawHub + LLM), the agent reaches
  // nothing else on the internet; allowlist = infra + `allowedHosts`; all = any
  // PUBLIC host (private/metadata ranges stay blocked in every mode). Absent →
  // treated as `none` (fail safe). Enforced by a per-run egress proxy, see
  // egress-proxy.cjs. The single escape hatch is CLAWHUB_RUNNER_NO_EGRESS_PROXY=1.
  egress?: { policy?: "none" | "allowlist" | "all"; allowedHosts?: string[] };
}

// Resolve the egress-proxy script that ships alongside the runner. Works in dev
// (tsx src/index.ts) and prod (dist/index.js): both sit one dir under the package
// root where egress-proxy.cjs lives.
const EGRESS_PROXY_SRC = fileURLToPath(new URL("../egress-proxy.cjs", import.meta.url));

// Live-log snapshot composition (pure, CommonJS so the node --test suite
// requires it directly — same pattern as janitorRules/egress-proxy.cjs below).
// See live-log-rules.cjs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveLogRules = createRequire(import.meta.url)("../live-log-rules.cjs") as {
  liveLogSnapshot: (rawLogs: string, liveLabel: string, liveTail: string) => string;
};

// Egress-sandbox janitor rules (pure, CommonJS so the node --test suite requires
// them directly — same pattern as egress-proxy.cjs). See janitor-rules.cjs for
// the why; the sweep itself is janitorSweep() below.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const janitorRules = createRequire(import.meta.url)("../janitor-rules.cjs") as {
  janitorMaxAgeMs: (raw: string | undefined) => number;
  isSandboxContainerName: (name: string) => boolean;
  isSandboxNetworkName: (name: string) => boolean;
  isStaleSandboxContainer: (c: { name: string; createdAtMs: number }, nowMs: number, maxAgeMs: number) => boolean;
  isStaleSandboxNetwork: (n: { name: string; createdAtMs: number; containerCount: number }, nowMs: number, maxAgeMs: number) => boolean;
};
const JANITOR_INTERVAL_MS = Number(process.env.CLAWHUB_RUNNER_JANITOR_INTERVAL_MS) || 15 * 60_000;
const EGRESS_PROXY_ENABLED = process.env.CLAWHUB_RUNNER_NO_EGRESS_PROXY !== "1";

// Extra host→addr mappings for the sandbox containers (proxy + agent), e.g.
// `host.docker.internal:host-gateway` so the contained agent can reach a ClawHub
// API that lives on the runner host. Comma-separated `name:addr` pairs.
function extraHostArgs(): string[] {
  const raw = (process.env.CLAWHUB_RUNNER_EXTRA_HOSTS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return raw.flatMap(h => ["--add-host", h]);
}

function hostOf(u: string | undefined): string | null {
  if (!u) return null;
  try { return new URL(u.includes("://") ? u : `http://${u}`).hostname.toLowerCase().replace(/^\[|\]$/g, ""); }
  catch { return null; }
}

// The union of common AI provider/aggregator API hosts + the auth/telemetry/
// control-plane hosts the baked-in coding-agent CLIs use. Always reachable as
// "infra" so a BYO agent on ANY provider works with just its key. Bare domains
// where per-account/regional subdomains exist. Researched 2026-06; see
// docs/agent-providers.md. (registry.npmjs.org/pypi.org/docker.all-hands.dev are
// install/runtime hosts — kept so a CLI's self-update / a pip/npm step still works.)
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
 * Hosts the container must always reach regardless of egress policy: ClawHub
 * (API + git, the agent's lifeline to get its issue and push code) and the LLM
 * endpoint (the brain). Derived from the injected env so a single-box self-host
 * whose API lives on a private address still works (infra bypasses the private-IP
 * guard). Well-known provider hosts are added so SDK defaults resolve even with
 * no explicit base URL set.
 */
function deriveInfraHosts(secrets: Record<string, string>): string[] {
  const hosts = new Set<string>();
  const add = (h: string | null) => { if (h) hosts.add(h); };
  add(hostOf(BASE));                       // the URL the runner itself clones from
  add(hostOf(secrets.CLAWHUB_URL));        // the URL the agent pushes to (may differ)
  for (const [k, v] of Object.entries(secrets)) if (/BASE_URL$/i.test(k)) add(hostOf(v));
  // The union of every common AI provider / aggregator API host + the CLI
  // control-plane/auth/telemetry hosts the baked-in coding CLIs need, so a BYO
  // agent on ANY provider works under egress=none with just its key — no per-image
  // or per-host config. Bare registrable domains where regional/per-account/per-
  // resource subdomains exist (amazonaws.com, *.azure.com bases, githubcopilot.com,
  // aiplatform.googleapis.com). localhost/private ranges are deliberately NOT here:
  // a self-hosted model runs inside the sandbox and is reached without leaving it,
  // and the SSRF guard always blocks loopback/metadata. See AI_PROVIDER_HOSTS.
  for (const d of AI_PROVIDER_HOSTS) hosts.add(d);
  return [...hosts];
}

async function dockerCmd(args: string[], timeoutMs = 30_000): Promise<{ code: number; out: string; err: string }> {
  const r = await runWithTimeout("docker", args, timeoutMs);
  return { code: r.timedOut ? 124 : r.code, out: r.out, err: r.err };
}

/** Poll until the proxy is accepting connections (or give up after ~5s). */
async function waitForProxy(proxyName: string): Promise<boolean> {
  const probe = "require('net').connect(8080,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))";
  for (let i = 0; i < 20; i++) {
    const r = await dockerCmd(["exec", proxyName, "node", "-e", probe], 3000);
    if (r.code === 0) return true;
    await new Promise(res => setTimeout(res, 250));
  }
  return false;
}

interface EgressSandbox { network: string; proxyName: string; agentEnv: Record<string, string>; teardown: () => Promise<string> }

/**
 * Stand up the per-run network containment: an `--internal` Docker network (no
 * route to the internet of its own) plus a dual-homed egress-proxy container that
 * is the ONLY way out and allow/deny-decides every connection. The agent runs on
 * the internal network with HTTP(S)_PROXY pointing at the proxy — if it ignores
 * the proxy and opens a raw socket, it has no route and fails closed.
 */
async function setupEgressSandbox(q: QueuedRun, secrets: Record<string, string>, secretsDir: string): Promise<EgressSandbox> {
  const short = q.runId.replace(/[^a-z0-9]/gi, "").slice(0, 18);
  const network = `clawhub-egr-${short}`;
  const proxyName = `clawhub-prx-${short}`;
  // The `build` capability (operator-allowlisted, server-stamped) builds ClawHub's
  // OWN trusted image from its OWN Dockerfile, which pulls from many public hosts
  // (mcr.microsoft.com base, ghcr.io push, github.com regctl, apt/npm/pip/playwright
  // CDNs). Enumerating them all is brittle, so a build run gets broad PUBLIC egress
  // — the SSRF guard still blocks private/loopback/link-local/CGNAT/cloud-metadata
  // in every mode, so "all" is not "reach the box's own Postgres".
  const policy = q.execution === "build" ? "all" : (q.egress?.policy ?? "none");
  const allow = (q.egress?.allowedHosts ?? []).join(",");
  const infra = deriveInfraHosts(secrets).join(",");

  // The agent's network has NO NAT to the outside (`--internal`). Created fresh
  // per run and torn down after, so runs never share a network.
  // Idempotent against our own debris: names derive from the run id and the atomic
  // claim prevents two live attempts, so a same-named network/container can only be
  // a leftover from a CRASHED prior attempt of this very run (e.g. the runner was
  // bounced by a self-deploy mid-setup). Remove it instead of failing the retry on
  // "network ... already exists".
  await dockerCmd(["rm", "-f", proxyName, `clawhub-run-${short}`], 10_000).catch(() => {});
  await dockerCmd(["network", "rm", network], 10_000).catch(() => {});
  const netCreate = await dockerCmd(["network", "create", "--internal", "--driver", "bridge", network]);
  if (netCreate.code !== 0) throw new Error(`egress network create failed: ${netCreate.err.slice(-400)}`);

  // Mount the proxy from inside the per-run secrets dir (already a mountable
  // location) so the daemon can bind it without depending on the package path.
  const proxyFile = path.join(secretsDir, "egress-proxy.cjs");
  await copyFile(EGRESS_PROXY_SRC, proxyFile);

  const proxyImage = process.env.CLAWHUB_RUNNER_PROXY_IMAGE ?? "node:20-slim";
  const proxyStart = await dockerCmd(["run", "-d", "--name", proxyName,
    "--network", network,
    "--memory", "256m", "--cpus", "1", "--cpu-shares", String(CPU_SHARES),
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    ...extraHostArgs(),
    "-v", `${proxyFile}:/egress-proxy.cjs:ro`,
    "-e", `EGRESS_POLICY=${policy}`,
    "-e", `EGRESS_ALLOW=${allow}`,
    "-e", `EGRESS_INFRA=${infra}`,
    proxyImage, "node", "/egress-proxy.cjs",
  ]);
  const teardown = async (): Promise<string> => {
    let logs = "";
    try { const l = await dockerCmd(["logs", proxyName], 5000); logs = `${l.out}\n${l.err}`; } catch { /* best effort */ }
    await dockerCmd(["rm", "-f", proxyName], 10_000).catch(() => {});
    // `docker rm -f` returns BEFORE the network endpoint fully releases, so a single
    // `network rm` loses the race ("network has active endpoints") and silently leaks the
    // network. That leak accumulates until the daemon's address pool is fully subnetted and
    // EVERY subsequent run fails at network create. Retry until the endpoint releases (a
    // second or two); treat an already-gone network as success.
    for (let attempt = 0; attempt < 6; attempt++) {
      const rm = await dockerCmd(["network", "rm", network], 10_000).catch(() => ({ code: 1, out: "", err: "" }));
      if (rm.code === 0 || /no such network/i.test(rm.err)) break;
      await new Promise(r => setTimeout(r, 750));
    }
    return logs;
  };
  if (proxyStart.code !== 0) { await teardown(); throw new Error(`egress proxy start failed: ${proxyStart.err.slice(-400)}`); }

  // Give the proxy a second interface WITH internet (the agent never gets one).
  const connect = await dockerCmd(["network", "connect", "bridge", proxyName]);
  if (connect.code !== 0) { await teardown(); throw new Error(`egress proxy internet attach failed: ${connect.err.slice(-400)}`); }
  await waitForProxy(proxyName);

  const proxyUrl = `http://${proxyName}:8080`;
  const noProxy = "localhost,127.0.0.1,::1";
  return {
    network, proxyName,
    agentEnv: {
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl,
      NO_PROXY: noProxy, no_proxy: noProxy,
      // Some tools (notably the LLM SDKs over undici/Node fetch) only honour a
      // proxy when told explicitly; surface it so the harness can opt in.
      CLAWHUB_EGRESS_PROXY: proxyUrl, CLAWHUB_EGRESS_POLICY: policy,
    },
    teardown,
  };
}

interface PipelineStep { name?: string; run: string; image?: string }

function parseYaml(yaml: string): { steps: PipelineStep[] } {
  // Minimal parser for the steps list. A step starts at any `- ` item —
  // whether the first key is `run:` or `name:` — keys may come in any order.
  const out: PipelineStep[] = [];
  const lines = yaml.split(/\r?\n/);
  let current: PipelineStep | null = null;
  const flush = () => { if (current?.run) out.push(current); current = null; };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const item = line.match(/^\s*-\s*(\w+):\s*(.+)$/);
    if (item) {
      flush();
      current = { run: "" };
      if (item[1] === "run") current.run = item[2].trim();
      else if (item[1] === "name") current.name = item[2].trim();
      else if (item[1] === "image") current.image = item[2].trim();
      continue;
    }
    const kv = line.match(/^\s+(name|run|image):\s*(.+)$/);
    if (current && kv) {
      if (kv[1] === "run") current.run = kv[2].trim();
      else if (kv[1] === "name") current.name = kv[2].trim();
      else current.image = kv[2].trim();
    }
  }
  flush();
  return { steps: out };
}

// `onChunk`, when given, is called with every stdout/stderr chunk AS it
// arrives (interleaved, not stream-separated) — the live tail a caller mirrors
// into a heartbeat report so a run's log page can show progress before the
// command finishes. Purely additive: `out`/`err` accumulate exactly as before.
async function runShell(cmd: string, cwd: string, env: Record<string, string>, onChunk?: (chunk: string) => void): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn("sh", ["-c", cmd], { cwd, env });
    let out = "", err = "";
    child.stdout.on("data", d => { const s = d.toString(); out += s; onChunk?.(s); });
    child.stderr.on("data", d => { const s = d.toString(); err += s; onChunk?.(s); });
    child.on("close", code => resolve({ code: code ?? 1, out, err }));
  });
}

/** Spawn a process with a hard wall-clock timeout (SIGKILL on expiry). See runShell for `onChunk`. */
async function runWithTimeout(cmd: string, args: string[], timeoutMs: number, onChunk?: (chunk: string) => void): Promise<{ code: number; out: string; err: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { env: process.env });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", d => { const s = d.toString(); out += s; onChunk?.(s); });
    child.stderr.on("data", d => { const s = d.toString(); err += s; onChunk?.(s); });
    child.on("close", code => { clearTimeout(timer); resolve({ code: code ?? 1, out, err, timedOut }); });
    child.on("error", e => { clearTimeout(timer); resolve({ code: 1, out, err: err + String((e as Error).message), timedOut }); });
  });
}

/**
 * Run a standing-agent's BYO container against the cloned repo. Unlike CI steps,
 * this gets network (to reach an LLM + browse + push) and the injected agent
 * token + LLM creds. Secrets are written to a mode-600 env-file (NOT the docker
 * argv, which `ps` leaks) that lives OUTSIDE the mounted workdir and is removed
 * after the run. The container is memory/CPU capped, drops all caps +
 * no-new-privileges, and is wall-clock bounded.
 *
 * Network containment: by default the container runs inside a per-run egress
 * sandbox (an `--internal` network whose only exit is an allowlisting proxy), so
 * whatever the agent reaches — browser navigation included — physically cannot
 * leave the allowed set, and private/metadata addresses are unreachable in every
 * mode. The legacy `--network bridge` (open egress) is only used when the
 * operator sets CLAWHUB_RUNNER_NO_EGRESS_PROXY=1.
 */
/**
 * Remove a run's workdir. A `--privileged` (verify/DinD) run executes as root and
 * can leave root-owned files (evidence, nested-docker state) that the non-root
 * runner cannot unlink (EACCES) — which would otherwise crash the run AFTER its
 * work already succeeded and leak the dir. So on failure we wipe the contents via a
 * throwaway root container on the same image (already present, no pull), then drop
 * the now-empty dir. Always best-effort: cleanup must never fail a run.
 */
async function cleanupWorkdir(workdir: string, image?: string): Promise<void> {
  if (await rm(workdir, { recursive: true, force: true }).then(() => true, () => false)) return;
  if (image) {
    await dockerCmd(["run", "--rm", "--entrypoint", "sh", "-v", `${workdir}:/w`, image,
      "-c", "rm -rf /w/..?* /w/.[!.]* /w/* 2>/dev/null || true"], 30_000).catch(() => {});
  }
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

async function runContainer(q: QueuedRun, workdir: string, env: Record<string, string>, onChunk?: (chunk: string) => void): Promise<{ code: number; out: string; err: string }> {
  // The container runs as root, but the NON-privileged tiers (static/app/services)
  // drop CAP_DAC_OVERRIDE — so in-container root canNOT bypass file permissions, and
  // the workdir (mkdtemp 0700, owned by the runner user) is then UNREADABLE at
  // /workspace (verify_cfg sees nothing → no boot; tests can't run). Privileged dind
  // worked only because it keeps that capability. Make the workspace accessible
  // (public repo source — secrets live in their own 0700 dir, never here). X = dirs
  // only, so files stay non-executable. Runs as the workdir owner (the runner user).
  await runShell("chmod -R a+rwX .", workdir, process.env as Record<string, string>).catch(() => {});
  // Hold the env-file (unsealed agent JWT + LLM key) in its OWN 0700 dir — never
  // the mounted workdir (the container would read it) and never a predictable
  // shared name. mkdtemp gives an unguessable path; chmod 0700 blocks other users.
  const secretsDir = await mkdtemp(path.join(WORKROOT, "secrets-"));
  await chmod(secretsDir, 0o700);

  // Establish network containment before writing the env-file, so the proxy
  // address is injected alongside the secrets. Fail CLOSED: if we can't build the
  // sandbox we do NOT silently fall back to open egress.
  let sandbox: EgressSandbox | null = null;
  let networkArg = "bridge";
  let agentEnv: Record<string, string> = {};
  if (EGRESS_PROXY_ENABLED) {
    try {
      sandbox = await setupEgressSandbox(q, env, secretsDir);
      networkArg = sandbox.network;
      agentEnv = sandbox.agentEnv;
    } catch (e) {
      await rm(secretsDir, { recursive: true, force: true });
      return { code: 1, out: "", err: `[runner] egress sandbox setup failed (refusing to run with open network): ${(e as Error).message}` };
    }
  }

  const envFile = path.join(secretsDir, "env");
  // Non-secret runtime hints the harness reads (the verification tier it should boot).
  // CLAWHUB_TOOLS (the capability grant) flows in via the gated secrets endpoint, or
  // defaults to full in the harness.
  const runtimeEnv: Record<string, string> = {};
  if (q.verifyTier) runtimeEnv.CLAWHUB_VERIFY_TIER = q.verifyTier;
  // Tier 2 (`services`): mint a FRESH per-run database from the pooled, pre-migrated
  // Postgres (no DinD, no build) + a scoped role, reachable only on this run's
  // network. Injected as DATABASE_URL/REDIS_URL for the Change's serve. Pool is
  // opt-in (CLAWHUB_VERIFY_POOL=1) + null-on-failure → the services tier then falls
  // back to the heavy dind path. The pooled DB never runs Change code. See service-pool.ts.
  let pooled: AcquiredServices | null = null;
  let effectiveDind = q.dind;
  if (q.verifyTier === "services" || q.standing) {
    pooled = await acquireServices(dockerCmd, q.runId, networkArg).catch(() => null);
    if (pooled) {
      runtimeEnv.CLAWHUB_DB_URL = pooled.dbUrl;
      runtimeEnv.DATABASE_URL = pooled.dbUrl;
      runtimeEnv.CLAWHUB_REDIS_URL = pooled.redisUrl;
      runtimeEnv.REDIS_URL = pooled.redisUrl;
    } else if (q.verifyTier === "services") {
      // No pool (disabled/failed) → the services tier can't boot its DB non-privileged.
      // Promote to the heavy dind path so the change STILL verifies (the harness uses
      // dind_serve). Robust by degradation — never a silently-broken verify.
      effectiveDind = true;
      runtimeEnv.CLAWHUB_VERIFY_TIER = "dind";
    }
    // Standing agent runs: pooled is best-effort — the serve script falls back to
    // localhost defaults if the pool is unavailable.  No dind promotion needed.
  }
  // env-file format is KEY=VALUE per line; values may contain anything except a
  // newline, so collapse CR/LF in injected values to keep one var per line.
  const lines = Object.entries({ ...env, ...runtimeEnv, ...agentEnv })
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, " ")}`);
  await writeFile(envFile, lines.join("\n"), { mode: 0o600 });

  const timeoutMs = Math.max(60_000, (q.timeoutSec ?? 1800) * 1000);
  // A verify run boots an app (npm ci + tsx/next dev + Chromium, or a nested
  // compose) — that does NOT fit in the 1 GB default and a backgrounded proc OOM-
  // killed mid-boot (which `set -e` can't catch) would yield a green attestation off
  // a half-dead stack. Floor verify-tier containers well above the default.
  const isVerify = !!q.verifyTier || effectiveDind;
  // Non-verify CI still runs a full `npm install` + `tsc` build. As the API
  // package grew, `tsc` began peaking OVER the old 1 GB cap and got OOM-killed
  // (SIGKILL / exit 137) mid-build — a spurious CI failure that has nothing to
  // do with the change under test. Floor contained CI at CI_MEMORY_MB (env-
  // tunable) so the type-checker has headroom; the load-aware admission gate
  // (waitForHostHeadroom) still keeps the box from overcommitting. A pipeline
  // that asks for MORE (q.memoryMb) is honored; the floor only ever raises.
  const memMb = isVerify ? Math.max(q.memoryMb ?? 0, 4096) : Math.max(q.memoryMb ?? 0, CI_MEMORY_MB);
  const args = [
    "run", "--rm",
    // Deterministic name so ci.run.canceled (supersede/stuck) can `docker rm -f` it.
    "--name", `clawhub-run-${q.runId.replace(/[^a-z0-9]/gi, "").slice(0, 18)}`,
    "--network", networkArg,                     // contained per-run net, or legacy bridge
    "--memory", `${memMb}m`,
    "--cpus", String(q.cpus ?? 1),
    // Low CPU WEIGHT so this async CI/agent container YIELDS to the critical services
    // (api/dashboard at the default 1024 share) under contention — a heavy verify loop
    // can't starve the UI/API on a shared box. Priority tiering by kernel CPU shares.
    "--cpu-shares", String(CPU_SHARES),
  ];
  if (effectiveDind) {
    // Docker-in-Docker (the `dind` tier, or a `services` run with no pool): the
    // container starts its OWN dockerd to boot a multi-service app for true e2e
    // verification. dockerd needs --privileged. Containment still holds: the nested
    // containers run INSIDE this container and their egress NATs out through this
    // container's only interface — the per-run --internal network whose sole exit is
    // the allowlisting egress proxy. We mount a tmpfs at /var/lib/docker so the
    // nested image store doesn't bloat the overlay.
    args.push("--privileged", "--tmpfs", "/var/lib/docker");
  } else if (q.execution === "build") {
    // Rootless BuildKit tier: NOT privileged, NO docker socket, NO host mount, still on the
    // --internal net behind the egress proxy — but user-namespaced rootless build needs
    // seccomp + apparmor unconfined. This is weaker than cap-drop=ALL, which is exactly why
    // `build` is server-stamped (allowlisted repos only) and never tenant-reachable.
    args.push("--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined");
  } else {
    args.push("--cap-drop=ALL", "--security-opt=no-new-privileges");
  }
  args.push(
    ...extraHostArgs(),
    "--env-file", envFile,
    "-v", `${workdir}:/workspace`, "-w", "/workspace",
  );
  // A command override forces an `sh -c` entrypoint; otherwise the image's own
  // ENTRYPOINT runs (the documented contract in docs/standing-agents.md).
  if (q.command) args.push("--entrypoint", "sh", q.image!, "-c", q.command);
  else args.push(q.image!);

  // Refresh the image before running it. `docker run` uses whatever is cached locally,
  // so after the harness image is republished (the build-harness CI matrix natively, or
  // the self-deploy QEMU fallback) this host would otherwise keep running the STALE
  // cached :latest forever — the runner has no --pull. A pull on an up-to-date tag is a
  // fast digest check; on a changed tag it fetches only the new layers. Best-effort: on
  // a registry error we proceed with the cached image (an old image beats a failed run) —
  // this is a freshness optimization, not a gate, and a truly-absent image still
  // auto-pulls on `docker run`.
  if (q.image) await runWithTimeout("docker", ["pull", q.image], 600_000).catch(() => {});

  try {
    const r = await runWithTimeout("docker", args, timeoutMs, onChunk);
    // Surface the proxy's egress decision log so the run record shows exactly
    // what the agent reached and what was blocked — auditable evidence.
    let egressLog = "";
    if (sandbox) { try { egressLog = await sandbox.teardown(); sandbox = null; } catch { /* logged below */ } }
    const egressTail = egressLog ? `\n[runner] egress decisions (policy=${q.egress?.policy ?? "none"}):\n${egressLog.slice(-2000)}` : "";
    if (r.timedOut) return { code: r.code || 124, out: r.out, err: `${r.err}\n[runner] standing run exceeded ${q.timeoutSec ?? 1800}s timeout; killed${egressTail}` };
    return { code: r.code, out: r.out, err: r.err + egressTail };
  } finally {
    // Drop the per-run database + scoped role and disconnect the pool from this run's
    // network — nothing of this tenant's run survives in the shared cluster.
    if (pooled) await releaseServices(dockerCmd, q.runId, networkArg).catch(() => {});
    if (sandbox) await sandbox.teardown().catch(() => {});
    await rm(secretsDir, { recursive: true, force: true });
  }
}

async function fetchSecrets(runId: string, runnerToken: string): Promise<Record<string, string>> {
  try {
    // Also present our agent token: in a multi-tenant deployment the server
    // (CLAWHUB_RUNNER_AGENT_IDS set) binds secrets delivery to an allowlisted
    // runner agent, so the per-run runnerToken alone is not sufficient. Harmless
    // for single-tenant servers, which ignore it.
    const headers: Record<string, string> = { "x-runner-token": runnerToken };
    if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE}/api/v1/ci/runs/${runId}/secrets`, { headers });
    if (!res.ok) return {};
    const j = await res.json() as { secrets: Record<string, string> };
    return j.secrets;
  } catch { return {}; }
}

// Run ids currently being processed by THIS runner — duplicate ci.run.queued
// deliveries for one of these are dropped at the SSE handler.
const inFlightRuns = new Set<string>();

// Active progress-heartbeat timers by runId (unified scheduler stuck-detection). A
// terminal report clears the run's heartbeat so it stops re-reporting 'running'.
const activeHeartbeats = new Map<string, ReturnType<typeof setInterval>>();
function stopHeartbeat(runId: string): void {
  const hb = activeHeartbeats.get(runId);
  if (hb) { clearInterval(hb); activeHeartbeats.delete(runId); }
}

// Active log-flush timers by runId — a faster-cadence sibling of the heartbeat
// above that ships the CURRENT command's live output (see liveLogSnapshot) so
// the run details page can show progress before the whole run finishes.
const activeLogFlushes = new Map<string, ReturnType<typeof setInterval>>();
function stopLogFlush(runId: string): void {
  const lf = activeLogFlushes.get(runId);
  if (lf) { clearInterval(lf); activeLogFlushes.delete(runId); }
}

async function reportStatus(runId: string, runnerToken: string, status: "running" | "success" | "failure" | "skipped", body: { logUrl?: string; rawLogs?: string; stepResults?: unknown[]; heartbeat?: boolean } = {}): Promise<boolean> {
  if (status !== "running") { stopHeartbeat(runId); stopLogFlush(runId); } // terminal report ends both timers
  // Terminal reports retry for ~1 minute: a deploy pipeline may restart the
  // very API we report to (self-hosted ClawHub deploying itself), and the run
  // row lives in Postgres — the report just needs to land once the API is
  // back. Claims ("running") stay single-shot: if the API can't take the
  // claim, another runner (or a later event) should win it instead.
  const attempts = status === "running" ? 1 : 12;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 5_000));
    try {
      const res = await fetch(`${BASE}/api/v1/ci/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runner_token: runnerToken, status, node_id: NODE_ID, ...body }),
      });
      if (res.status === 409) return false; // another runner claimed it
      if (res.ok) return true;
      if (res.status < 500) return false; // 4xx won't improve with retries
      process.stderr.write(`[runner] status report got ${res.status}, attempt ${i + 1}/${attempts}\n`);
    } catch (e) {
      process.stderr.write(`[runner] status report failed (attempt ${i + 1}/${attempts}): ${(e as Error).message}\n`);
    }
  }
  return false;
}

async function runOne(q: QueuedRun): Promise<void> {
  // Self-heal WORKROOT before every run. It's created once in main(), but a
  // tmp-cleaner (WORKROOT defaults under /tmp) can delete it out from under a
  // long-running runner — after which every mkdtemp here fails with ENOENT and
  // CI silently stops accepting work until the service is restarted. Recreating
  // it per run makes the runner survive tmp cleanup. (2026-06-20: this exact
  // failure stalled prod CI.)
  await mkdir(WORKROOT, { recursive: true });
  const workdir = await mkdtemp(path.join(WORKROOT, "run-"));
  const cloneUrl = `${BASE.replace(/^https?:\/\//, m => m + `agent-token:${TOKEN}@`)}/${q.repoNs}/${q.repoName}.git`;

  // The running-report is the claim — if another runner got there first,
  // drop the job instead of executing it twice.
  if (!(await reportStatus(q.runId, q.runnerToken, "running"))) {
    process.stdout.write(`[runner] ${q.runId} already claimed, skipping\n`);
    await cleanupWorkdir(workdir, q.image);
    return;
  }
  // Claim won — start the progress heartbeat. Each tick re-reports 'running', which
  // the API turns into a lastHeartbeatAt bump (the initial claim doesn't set it). The
  // heartbeat is cleared by the terminal reportStatus below (or the run-failed catch
  // in subscribeOnce). unref'd so it never keeps the process alive on its own.
  // `heartbeat:true` distinguishes these ticks from a claim — the API 409s an
  // unflagged early re-claim (the duplicate-delivery double-run guard).
  const hb = setInterval(() => { void reportStatus(q.runId, q.runnerToken, "running", { heartbeat: true }); }, RUN_HEARTBEAT_MS);
  if (typeof hb.unref === "function") hb.unref();
  activeHeartbeats.set(q.runId, hb);

  // Review-only (M4): NO clone/checkout — the reviewer reads the diff via the API,
  // so no repo code ever lands in the container. Everything else (secrets, the
  // egress-contained container) is identical.
  let rawLogs = "";
  // Live tail of whatever command is executing RIGHT NOW (see liveLogSnapshot):
  // liveLabel names it, liveTail accumulates its output as it streams. Both
  // reset to "" once that command finalizes and its own block lands in
  // rawLogs — set by the call sites below via a small onChunk callback.
  let liveLabel = "";
  let liveTail = "";

  // A faster-cadence sibling of the heartbeat: ships the run's log page a
  // fresh snapshot (finalized steps + the current step's live tail) every
  // LOG_FLUSH_MS, independent of the 60s heartbeat's claim-liveness cadence.
  // Skips the POST when nothing new has streamed since the last tick.
  let lastFlushedLen = 0;
  const logFlush = setInterval(() => {
    const snapshot = liveLogRules.liveLogSnapshot(rawLogs, liveLabel, liveTail);
    if (snapshot.length === lastFlushedLen) return;
    lastFlushedLen = snapshot.length;
    void reportStatus(q.runId, q.runnerToken, "running", { heartbeat: true, rawLogs: snapshot });
  }, LOG_FLUSH_MS);
  if (typeof logFlush.unref === "function") logFlush.unref();
  activeLogFlushes.set(q.runId, logFlush);

  if (!q.reviewOnly) {
    // --no-single-branch: --depth alone implies single-branch (default branch
    // only), but the commit under test usually lives on a Change branch.
    const cloneResult = await runShell(`git clone --depth 50 --no-single-branch "${cloneUrl}" .`, workdir, process.env as Record<string, string>);
    rawLogs += `=== git clone ===\nexit code: ${cloneResult.code}\nstdout:\n${cloneResult.out}\nstderr:\n${cloneResult.err}\n\n`;
    if (cloneResult.code !== 0) {
      await reportStatus(q.runId, q.runnerToken, "failure", {
        rawLogs,
        stepResults: [{ name: "clone", passed: false, exitCode: cloneResult.code, out: "", err: cloneResult.err.slice(-4000) }]
      });
      await cleanupWorkdir(workdir, q.image);
      return;
    }
    // Failing to land on the requested commit must fail the run — silently
    // testing the wrong commit is worse than no test at all.
    let co = await runShell(`git checkout --detach ${q.commit}`, workdir, process.env as Record<string, string>);
    rawLogs += `=== git checkout ${q.commit} ===\nexit code: ${co.code}\nstdout:\n${co.out}\nstderr:\n${co.err}\n\n`;
    // A Change head usually lives only on a Change ref (refs/changes/<id> or
    // refs/clawhub/changes/<id>) that the clone never fetched — so the first
    // checkout misses. Fetch the Change ref by id (uuid-guarded against injection)
    // and retry. Only happens for change-scoped runs (verify/review).
    if (co.code !== 0 && q.changeId && /^[0-9a-fA-F-]{36}$/.test(q.changeId)) {
      const id = q.changeId;
      const fetchResult = await runShell(
        `git fetch --depth 50 origin "+refs/changes/${id}:refs/changes/${id}" 2>/dev/null || ` +
        `git fetch --depth 50 origin "+refs/clawhub/changes/${id}:refs/clawhub/changes/${id}"`,
        workdir, process.env as Record<string, string>,
      );
      rawLogs += `=== git fetch change ${id} ===\nexit code: ${fetchResult.code}\nstdout:\n${fetchResult.out}\nstderr:\n${fetchResult.err}\n\n`;
      co = await runShell(`git checkout --detach ${q.commit}`, workdir, process.env as Record<string, string>);
      rawLogs += `=== git checkout retry ${q.commit} ===\nexit code: ${co.code}\nstdout:\n${co.out}\nstderr:\n${co.err}\n\n`;
    }
    if (co.code !== 0) {
      await reportStatus(q.runId, q.runnerToken, "failure", {
        rawLogs,
        stepResults: [{ name: "checkout", passed: false, exitCode: co.code, out: "", err: co.err.slice(-4000) }]
      });
      await cleanupWorkdir(workdir, q.image);
      return;
    }
  }

  const secrets = await fetchSecrets(q.runId, q.runnerToken);
  const env = { ...process.env, ...secrets } as Record<string, string>;

  // Standing-agent run: run the BYO container (with network + injected creds)
  // instead of pipeline steps. The container does the inference and pushes any
  // work as a Change through the normal governance flow.
  if (q.standing && q.image) {
    liveLabel = "standing-agent"; liveTail = "";
    const r = await runContainer(q, workdir, secrets, chunk => { liveTail += chunk; });
    liveLabel = ""; liveTail = "";
    rawLogs += `=== standing-agent ===\nexit code: ${r.code}\nstdout:\n${r.out}\nstderr:\n${r.err}\n\n`;
    await reportStatus(q.runId, q.runnerToken, r.code === 0 ? "success" : "failure", {
      rawLogs,
      stepResults: [{ name: "standing-agent", passed: r.code === 0, exitCode: r.code, out: r.out.slice(-8000), err: r.err.slice(-8000) }],
    });
    await cleanupWorkdir(workdir, q.image);
    return;
  }

  // A `deploy` run (server-stamped for the allowlisted deploy repo ONLY, off a real merge)
  // runs the single fixed, reviewed deploy entrypoint on the host — NEVER the pipeline's YAML
  // steps — so a deploy pipeline cannot inject arbitrary host shell. This is the one
  // irreducible host act (restart the box's own stack) done by trusted infra (the runner),
  // not tenant/pipeline shell. scripts/self-deploy.sh cd's to the live checkout itself.
  // Fully-CONTAINED image builds (so even this shrinks) are the follow-up, gated on rootless
  // BuildKit fitting the host. See services/ci-host-exec.ts + docs/operations.md.
  if (q.execution === "deploy") {
    liveLabel = "deploy"; liveTail = "";
    const r = await runShell("sh scripts/self-deploy.sh", workdir, env, chunk => { liveTail += chunk; });
    liveLabel = ""; liveTail = "";
    rawLogs += `=== deploy ===\nexit code: ${r.code}\nstdout:\n${r.out}\nstderr:\n${r.err}\n\n`;
    await reportStatus(q.runId, q.runnerToken, r.code === 0 ? "success" : "failure", {
      rawLogs,
      stepResults: [{ name: "deploy", passed: r.code === 0, exitCode: r.code, out: r.out.slice(-8000), err: r.err.slice(-8000) }],
    });
    await cleanupWorkdir(workdir, q.image);
    return;
  }

  const pipeline = parseYaml(q.pipelineYaml);

  // BUILD (server-stamped, allowlisted repos only): run the build steps in a CONTAINED
  // rootless-BuildKit sandbox — build+push images with NO host docker. Still contained
  // (--internal net + egress proxy + no host mount + secrets-only env), on a server-pinned
  // build image, with the build-tier seccomp relaxation (runContainer, gated on q.execution).
  // Egress must reach the registries + base-image/toolchain hosts, so default `all` (private/
  // metadata stay blocked). This is how the image build stops needing `execution: host`.
  if (q.execution === "build") {
    const script = `set -e\n${pipeline.steps.map(s => s.run).join("\n")}`;
    liveLabel = "ci (build)"; liveTail = "";
    const r = await runContainer(
      { ...q, image: CI_BUILD_IMAGE, command: script, egress: q.egress ?? { policy: "all" } },
      workdir, secrets, chunk => { liveTail += chunk; },
    );
    liveLabel = ""; liveTail = "";
    rawLogs += `=== ci (build) ===\nexit code: ${r.code}\nstdout:\n${r.out}\nstderr:\n${r.err}\n\n`;
    await reportStatus(q.runId, q.runnerToken, r.code === 0 ? "success" : "failure", {
      rawLogs,
      stepResults: [{ name: "ci (build)", passed: r.code === 0, exitCode: r.code, out: r.out.slice(-8000), err: r.err.slice(-8000) }],
    });
    await cleanupWorkdir(workdir, CI_BUILD_IMAGE);
    return;
  }

  // Capability-graded execution. HOST (server-stamped for an operator-allowlisted repo only)
  // runs steps directly on the runner host with the full env — deploy/build need docker,
  // systemd, the live checkout. Everything else runs SANDBOXED.
  if (isHostExec(q)) {
    const results: Array<{ name?: string; passed: boolean; exitCode: number; out: string; err: string }> = [];
    let failed = false;
    for (const step of pipeline.steps) {
      liveLabel = `step: ${step.name || "unnamed"}`; liveTail = "";
      const r = await runShell(step.run, workdir, env, chunk => { liveTail += chunk; });
      liveLabel = ""; liveTail = "";
      rawLogs += `=== step: ${step.name || "unnamed"} ===\nrun: ${step.run}\nexit code: ${r.code}\nstdout:\n${r.out}\nstderr:\n${r.err}\n\n`;
      results.push({ name: step.name, passed: r.code === 0, exitCode: r.code, out: r.out.slice(-4000), err: r.err.slice(-4000) });
      if (r.code !== 0) { failed = true; break; }
    }
    await reportStatus(q.runId, q.runnerToken, failed ? "failure" : "success", {
      rawLogs,
      stepResults: results
    });
    await cleanupWorkdir(workdir, q.image);
    return;
  }

  // DEFAULT = SANDBOX (fail-closed): run the steps CONTAINED — a fresh per-run container on
  // an --internal network behind the fail-closed egress proxy, cap-drop=ALL, resource-limited
  // — with ONLY the per-run secrets (NOT env = {...process.env,...secrets}, so the runner's
  // own CLAWHUB_TOKEN never enters the container) and a SERVER-PINNED image (a repo cannot
  // pick it). An untrusted repo's CI thus cannot reach the host, docker, sibling workdirs, or
  // this runner's token — it cannot kill prod. Steps chain fail-fast (`set -e`); per-step
  // granularity collapses to one aggregate result for now (per-step reporting is a follow-up).
  // Egress defaults to `all` = the PUBLIC internet, so a real repo's CI can fetch its deps
  // (`npm ci`/`pip install`/git clone) — a sandbox with egress:none can't install anything and
  // is useless for most CI. The per-run proxy STILL blocks private/loopback/link-local/CGNAT/
  // cloud-metadata in EVERY mode, so contained CI reaches public registries yet CANNOT reach the
  // host or prod's private services (Postgres/Redis/the box). This is exactly what lets the
  // self-repo's own `tests` run through the identical tenant sandbox path (dogfooding) instead of
  // `execution: host`. A repo can still request a tighter egress via the payload (q.egress).
  const script = `set -e\n${pipeline.steps.map(s => s.run).join("\n")}`;
  liveLabel = "ci (sandboxed)"; liveTail = "";
  const r = await runContainer(
    { ...q, image: CI_SANDBOX_IMAGE, command: script, egress: q.egress ?? { policy: "all" } },
    workdir, secrets, chunk => { liveTail += chunk; },
  );
  liveLabel = ""; liveTail = "";
  rawLogs += `=== ci (sandboxed) ===\nexit code: ${r.code}\nstdout:\n${r.out}\nstderr:\n${r.err}\n\n`;
  await reportStatus(q.runId, q.runnerToken, r.code === 0 ? "success" : "failure", {
    rawLogs,
    stepResults: [{ name: "ci (sandboxed)", passed: r.code === 0, exitCode: r.code, out: r.out.slice(-8000), err: r.err.slice(-8000) }],
  });
  await cleanupWorkdir(workdir, CI_SANDBOX_IMAGE);
}

// Server-pinned image sandboxed CI steps run in. A repo CANNOT choose it (we ignore any
// YAML/payload image for CI) — that would defeat the point of a contained default.
const CI_SANDBOX_IMAGE = process.env.CLAWHUB_CI_DEFAULT_IMAGE ?? "node:20";
// Server-pinned image for `execution: build` — a rootless BuildKit image so CI can build+push
// images WITHOUT host docker. Contained (no host mount/socket, --internal net + egress proxy),
// just with the seccomp/apparmor relaxation rootless user-namespaces need (build-tier security
// in runContainer). NOTE: whether rootless BuildKit starts is kernel-specific (user namespaces
// must be enabled) — the one thing to confirm on the deploy host; see docs/operations.md.
const CI_BUILD_IMAGE = process.env.CLAWHUB_CI_BUILD_IMAGE ?? "moby/buildkit:rootless";

// Run CI steps on the HOST only when the SERVER stamped execution:"host" (operator-
// allowlisted repo). Fail-closed: absent/unknown ⇒ sandbox. The runner never trusts YAML.
function isHostExec(q: QueuedRun): boolean {
  return q.execution === "host";
}

// Bound concurrent runs so a burst of pushes (esp. sandboxed CI, each a container + network
// + proxy) can't exhaust the runner. A run waits for a slot BEFORE it claims — a busy runner
// defers, another runner claims first, and the deferred attempt just finds it taken (409).
const MAX_CONCURRENT = Math.max(1, Number(process.env.CLAWHUB_RUNNER_MAX_CONCURRENT ?? 2));
// Kernel CPU weight for every runner-spawned container (default 1024). Low weight ⇒
// async CI/agent work yields CPU to the critical compose services (api/dashboard) under
// contention, so it can never starve the UI/API on a shared box.
const CPU_SHARES = Math.max(2, Number(process.env.CLAWHUB_RUNNER_CPU_SHARES ?? 256));
// Load-aware admission (backpressure): a run is admitted only when the host has headroom,
// so a pile-up of async jobs can't overload the box. Thresholds are per-CPU-core loadavg
// and free memory; HEAVY runs (verify/dind, which boot a whole app + browser) gate stricter.
const MAX_LOAD_PER_CORE = Number(process.env.CLAWHUB_RUNNER_MAX_LOAD_PER_CORE ?? 2.0);
const HEAVY_MAX_LOAD_PER_CORE = Number(process.env.CLAWHUB_RUNNER_HEAVY_MAX_LOAD_PER_CORE ?? 1.25);
const MIN_FREE_MB = Number(process.env.CLAWHUB_RUNNER_MIN_FREE_MB ?? 384);
const ADMIT_MAX_WAIT_MS = Number(process.env.CLAWHUB_RUNNER_ADMIT_MAX_WAIT_MS ?? 180_000);

function hostHeadroom(heavy: boolean): { ok: boolean; loadPerCore: number; freeMb: number } {
  const cores = Math.max(1, osCpus().length);
  const loadPerCore = loadavg()[0] / cores;
  const freeMb = freemem() / (1024 * 1024);
  const cap = heavy ? HEAVY_MAX_LOAD_PER_CORE : MAX_LOAD_PER_CORE;
  return { ok: loadPerCore <= cap && freeMb >= MIN_FREE_MB, loadPerCore, freeMb };
}

// Wait until the host can absorb this run — the backpressure that keeps async CI/agent
// work from starving the critical services. Called BEFORE we claim, so a deferred run
// stays unclaimed (another runner or a later cycle can take it). Bounded: after
// ADMIT_MAX_WAIT_MS we admit anyway (the concurrency cap + low cpu-shares still contain it)
// so a persistently-busy box eventually drains its own queue rather than starving forever.
async function waitForHostHeadroom(heavy: boolean): Promise<void> {
  const deadline = Date.now() + ADMIT_MAX_WAIT_MS;
  for (let i = 0; ; i++) {
    const h = hostHeadroom(heavy);
    if (h.ok || Date.now() >= deadline) {
      if (i > 0) process.stdout.write(`[runner] admitting ${heavy ? "heavy " : ""}run (load/core ${h.loadPerCore.toFixed(2)}, free ${Math.round(h.freeMb)}MB${h.ok ? "" : ", wait budget spent"})\n`);
      return;
    }
    if (i === 0) process.stdout.write(`[runner] host busy (load/core ${h.loadPerCore.toFixed(2)} > ${(heavy ? HEAVY_MAX_LOAD_PER_CORE : MAX_LOAD_PER_CORE)}, free ${Math.round(h.freeMb)}MB) — deferring ${heavy ? "heavy " : ""}run\n`);
    await new Promise(r => setTimeout(r, 3000 + Math.floor(Math.random() * 2000)));
  }
}
// Heavy verify tiers (dind, and app/services boot a real app) are far more
// resource-hungry than a contained CI step — cap them separately so a single
// small node isn't swamped. DinD (--privileged nested dockerd) gets the tightest
// cap. A dind run takes BOTH a heavy slot and a global slot (acquired heavy-first,
// consistent order → no deadlock).
const DIND_MAX = Math.max(1, Number(process.env.CLAWHUB_RUNNER_MAX_CONCURRENT_DIND ?? 1));
// Memory floor for a CONTAINED (non-verify) CI container. `npm install` + `tsc`
// on the grown API package peaks above the old hard-coded 1 GB and got OOM-killed
// (exit 137) — a phantom failure unrelated to the diff. 3 GB gives the type-
// checker headroom; the load-aware admission gate still prevents overcommit.
// Env-tunable so a smaller node can lower it (or a bigger one raise it).
const CI_MEMORY_MB = Math.max(512, Number(process.env.CLAWHUB_RUNNER_CI_MEMORY_MB ?? 3072));
let activeRuns = 0, heavyActive = 0;
const slotWaiters: Array<() => void> = [];
const heavyWaiters: Array<() => void> = [];
// app/services/dind all boot a real app (4GB-floored containers) — cap them all
// against the heavy slot so a small node can't run MAX_CONCURRENT at once and OOM.
function isHeavy(q: QueuedRun): boolean { return q.verifyTier === "dind" || q.verifyTier === "services" || q.verifyTier === "app" || !!q.dind; }
async function withRunSlot<T>(q: QueuedRun, fn: () => Promise<T>): Promise<T> {
  const heavy = isHeavy(q);
  // Backpressure FIRST (before claiming a concurrency slot or reporting 'running'): wait
  // for host headroom so a busy box defers this run instead of tipping over.
  await waitForHostHeadroom(heavy);
  if (heavy && heavyActive >= DIND_MAX) await new Promise<void>(res => heavyWaiters.push(res));
  if (heavy) heavyActive++;
  if (activeRuns >= MAX_CONCURRENT) await new Promise<void>(res => slotWaiters.push(res));
  activeRuns++;
  try { return await fn(); }
  finally {
    activeRuns--; const next = slotWaiters.shift(); if (next) next();
    if (heavy) { heavyActive--; const hn = heavyWaiters.shift(); if (hn) hn(); }
  }
}

// Heavy-tier placement HINT: when this runner is tagged with a node type
// (CLAWHUB_RUNNER_NODE_TYPE) and a preferred heavy node is named
// (CLAWHUB_RUNNER_HEAVY_TIER_NODE, e.g. "debian"), a lean/OCI node LEAVES heavy
// verify runs (app/services/dind) for the beefier node — the atomic claim means
// the preferred node picks them up. Fail-safe: either var unset ⇒ any runner.
const NODE_TYPE = (process.env.CLAWHUB_RUNNER_NODE_TYPE ?? "").trim();
const HEAVY_TIER_NODE = (process.env.CLAWHUB_RUNNER_HEAVY_TIER_NODE ?? "").trim();
function deferHeavyTier(q: QueuedRun): boolean {
  if (!NODE_TYPE || !HEAVY_TIER_NODE || NODE_TYPE === HEAVY_TIER_NODE) return false;
  const heavyTier = q.verifyTier === "dind" || q.verifyTier === "services" || q.verifyTier === "app";
  return heavyTier;
}

// --- Unified async-job scheduler (docs/job-scheduler-design.md) ---
// This node's stable id (for the scheduler's assigned_node placement + capacity
// heartbeat). Defaults to the hostname.
const NODE_ID = (process.env.CLAWHUB_RUNNER_NODE_ID ?? hostname() ?? "runner").trim();
const NODE_HEARTBEAT_TOKEN = (process.env.CLAWHUB_RUNNER_NODE_TOKEN ?? "").trim();
// Prod reserve: on the box co-located with prod (the OCI node) the runner advertises
// its free cpu/mem ALREADY MINUS this reserve, so the scheduler can never place onto
// the headroom production needs. Set these only on the co-located runner.
const PROD_RESERVE_CPUS = Number(process.env.CLAWHUB_NODE_PROD_RESERVE_CPUS ?? 0);
const PROD_RESERVE_MEM_MB = Number(process.env.CLAWHUB_NODE_PROD_RESERVE_MEM_MB ?? 0);
const NODE_HEARTBEAT_MS = Number(process.env.CLAWHUB_NODE_HEARTBEAT_MS ?? 5_000);
// Progress heartbeat cadence while a run's container is alive (the API's stuck reaper
// flags a running run whose heartbeat goes stale). Must be well under the reaper's
// CLAWHUB_CI_HEARTBEAT_STUCK_MS (default 6m).
const RUN_HEARTBEAT_MS = Number(process.env.CLAWHUB_RUN_HEARTBEAT_MS ?? 60_000);
// Cadence for streaming the CURRENT command's live output back to the API (see
// liveLogSnapshot) — deliberately independent of + faster than RUN_HEARTBEAT_MS,
// which governs claim-liveness/stuck detection, not log freshness.
const LOG_FLUSH_MS = Number(process.env.CLAWHUB_LOG_FLUSH_MS ?? 5_000);

/** This node's current free capacity (load/free-mem based), minus the prod reserve. */
function nodeCapacity(): Record<string, unknown> {
  const cores = osCpus().length || 1;
  const load = loadavg()[0] || 0;
  const cpusFree = Math.max(0, cores - load - PROD_RESERVE_CPUS);
  const memFreeMb = Math.max(0, Math.floor(freemem() / 1024 / 1024) - PROD_RESERVE_MEM_MB);
  return {
    nodeId: NODE_ID,
    nodeType: NODE_TYPE || undefined,
    arch: process.arch,
    cpusTotal: cores,
    memTotalMb: Math.floor(totalmem() / 1024 / 1024),
    cpusFree,
    memFreeMb,
  };
}

/** POST this node's capacity to the API (which records it in Redis for the scheduler). */
async function postNodeCapacity(): Promise<void> {
  try {
    await fetch(`${BASE}/api/v1/ci/nodes/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(NODE_HEARTBEAT_TOKEN ? { "x-runner-node-token": NODE_HEARTBEAT_TOKEN } : {}) },
      body: JSON.stringify(nodeCapacity()),
    });
  } catch { /* best-effort — a missed heartbeat just briefly ages this node out */ }
}

// Map a docker/uname-style arch label (from a pipeline `runs_on:`) to Node's
// process.arch vocabulary so a run's arch pin can be compared to THIS runner.
// linux/ prefix tolerated; unknown labels pass through (compare as-is → won't match).
function normalizeArch(a: string): string {
  const s = a.trim().toLowerCase().replace(/^linux\//, "");
  if (s === "amd64" || s === "x86_64" || s === "x64") return "x64";
  if (s === "arm64" || s === "aarch64") return "arm64";
  return s;
}

async function subscribeOnce(sseUrl: string): Promise<void> {
  const res = await fetch(sseUrl, { headers: { accept: "text/event-stream" } });
  if (!res.body) throw new Error("no sse body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value);
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const line = f.split("\n").find(l => l.startsWith("data: "));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "ci.run.queued" && ev.payload) {
          const q = ev.payload as QueuedRun;
          // Arch-targeted dispatch: leave an arch-pinned run for the matching runner.
          // Fail-safe — no runsOn ⇒ any runner claims (today's behavior). The atomic
          // running-report still de-dups among matching-arch runners.
          if (q.runsOn && normalizeArch(q.runsOn) !== process.arch) {
            process.stdout.write(`[runner] ${q.runId} runs_on=${q.runsOn} != ${process.arch} — leaving for a matching-arch runner\n`);
            continue;
          }
          if (deferHeavyTier(q)) {
            process.stdout.write(`[runner] ${q.runId} tier=${q.verifyTier} — leaving for the ${HEAVY_TIER_NODE} node (this is ${NODE_TYPE})\n`);
            continue;
          }
          // Deploy runs are HOST-BOUND (self-deploy.sh restarts THIS box's stack).
          // A worker node that doesn't host the stack sets CLAWHUB_RUNNER_NO_DEPLOY=1
          // and leaves every deploy for the stack host — the broadcast race can then
          // never put a deploy on the wrong machine. Absent (default) = current
          // behavior, so single-node self-hosters need no config.
          if (q.execution === "deploy" && process.env.CLAWHUB_RUNNER_NO_DEPLOY === "1") {
            process.stdout.write(`[runner] ${q.runId} is a deploy — this node is CLAWHUB_RUNNER_NO_DEPLOY, leaving it for the stack host\n`);
            continue;
          }
          // In-process de-dup: SSE can deliver the same ci.run.queued more than once
          // (republish, reconnect replay). Without this, two runOne()s raced the same
          // run — the server mistook the second same-token claim for a heartbeat, both
          // executed, and the loser's sandbox-collision failure terminalized the run
          // out from under the winner (prod run 8ac4c99e).
          if (inFlightRuns.has(q.runId)) {
            process.stdout.write(`[runner] ${q.runId} already in flight here, skipping duplicate delivery\n`);
            continue;
          }
          inFlightRuns.add(q.runId);
          process.stdout.write(`[runner] running ${q.runId} (${q.repoNs}/${q.repoName}@${q.commit})\n`);
          withRunSlot(q, () => runOne(q))
            .catch(e => { stopHeartbeat(q.runId); process.stderr.write(`[runner] run failed: ${(e as Error).message}\n`); })
            .finally(() => inFlightRuns.delete(q.runId));
        }
        // Supersede/stuck cancellation: the API asks us to stop a run whose diff went
        // stale (new head) or that is being retried. Stop its heartbeat + kill its
        // container (best-effort; the container's wall-clock SIGKILL is the backstop).
        if (ev.type === "ci.run.canceled" && ev.payload?.runId) {
          const rid = String(ev.payload.runId);
          stopHeartbeat(rid);
          const short = rid.replace(/[^a-z0-9]/gi, "").slice(0, 18);
          void dockerCmd(["rm", "-f", `clawhub-run-${short}`]).catch(() => {});
        }
      } catch { /* ignore */ }
    }
  }
}

/**
 * Egress-sandbox janitor: sweep leaked per-run networks/containers so debris from
 * crashed runner processes self-heals instead of accumulating until Docker's IPv4
 * address pool is exhausted (which fails EVERY new run at network create). Only
 * resources matching the exact sandbox naming scheme, only past an age no
 * legitimate run reaches (janitor-rules.cjs). CLAWHUB_RUNNER_JANITOR_MAX_AGE_MS=0
 * disables. Best-effort: any docker hiccup just waits for the next sweep.
 */
async function janitorSweep(): Promise<void> {
  const maxAge = janitorRules.janitorMaxAgeMs(process.env.CLAWHUB_RUNNER_JANITOR_MAX_AGE_MS);
  if (!maxAge) return;
  const now = Date.now();
  let removed = 0;
  try {
    // Containers first (their removal frees the networks for the same sweep).
    const ps = await dockerCmd(["ps", "-a", "--format", "{{.Names}}"], 15_000);
    const names = ps.out.split("\n").map(n => n.trim()).filter(n => janitorRules.isSandboxContainerName(n));
    for (const name of names) {
      const ins = await dockerCmd(["inspect", "--format", "{{.Created}}", name], 10_000);
      const createdAtMs = Date.parse(ins.out.trim());
      if (ins.code !== 0 || !Number.isFinite(createdAtMs)) continue;
      if (janitorRules.isStaleSandboxContainer({ name, createdAtMs }, now, maxAge)) {
        const rm = await dockerCmd(["rm", "-f", name], 15_000);
        if (rm.code === 0) removed++;
      }
    }
    const ls = await dockerCmd(["network", "ls", "--format", "{{.Name}}"], 15_000);
    const nets = ls.out.split("\n").map(n => n.trim()).filter(n => janitorRules.isSandboxNetworkName(n));
    for (const name of nets) {
      const ins = await dockerCmd(["network", "inspect", "--format", "{{.Created}}\t{{len .Containers}}", name], 10_000);
      if (ins.code !== 0) continue;
      const [createdRaw, countRaw] = ins.out.trim().split("\t");
      const createdAtMs = Date.parse(createdRaw ?? "");
      const containerCount = Number(countRaw ?? "1");
      if (!Number.isFinite(createdAtMs)) continue;
      if (janitorRules.isStaleSandboxNetwork({ name, createdAtMs, containerCount }, now, maxAge)) {
        const rm = await dockerCmd(["network", "rm", name], 15_000);
        if (rm.code === 0) removed++;
      }
    }
  } catch (e) {
    process.stderr.write(`[runner] janitor sweep failed: ${(e as Error).message}\n`);
  }
  if (removed) process.stdout.write(`[runner] janitor removed ${removed} stale sandbox resource(s)\n`);
}

async function main() {
  await mkdir(WORKROOT, { recursive: true });

  // Node capacity heartbeat (unified scheduler): advertise this node's live free
  // cpu/mem to the API every ~5s so the scheduler can place jobs resource-aware. A
  // missed beat just briefly ages this node out (TTL). unref'd — never blocks exit.
  void postNodeCapacity();
  const capTimer = setInterval(() => { void postNodeCapacity(); }, NODE_HEARTBEAT_MS);
  if (typeof capTimer.unref === "function") capTimer.unref();

  // Sandbox-debris janitor: one sweep shortly after boot (a restart is exactly
  // when a prior process left debris behind), then every ~15 min. unref'd.
  const bootJanitor = setTimeout(() => { void janitorSweep(); }, 30_000);
  if (typeof bootJanitor.unref === "function") bootJanitor.unref();
  const janitorTimer = setInterval(() => { void janitorSweep(); }, JANITOR_INTERVAL_MS);
  if (typeof janitorTimer.unref === "function") janitorTimer.unref();

  // Subscribe to ci.run.queued via SSE and pick up work. The stream WILL
  // drop — most notably when a deploy pipeline restarts the very API we are
  // subscribed to. Dying here would make systemd restart us and kill the
  // in-flight deploy with the rest of the cgroup, so we reconnect forever
  // instead; the atomic claim makes replayed events harmless.
  const sseUrl = `${BASE}/api/v1/events/stream${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
  process.stdout.write(`[runner] subscribing to ${sseUrl}\n`);
  for (;;) {
    try {
      await subscribeOnce(sseUrl);
      process.stdout.write("[runner] event stream ended; reconnecting\n");
    } catch (e) {
      process.stderr.write(`[runner] event stream error: ${(e as Error).message}; reconnecting\n`);
    }
    await new Promise(r => setTimeout(r, 3_000 + Math.floor(Math.random() * 2_000)));
  }
}

void main().catch(e => { process.stderr.write(`[runner] fatal: ${(e as Error).message}\n`); process.exit(1); });
