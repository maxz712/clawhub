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
import { mkdir, mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const BASE = (process.env.CLAWHUB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.CLAWHUB_TOKEN ?? "";
const WORKROOT = process.env.CLAWHUB_RUNNER_WORKDIR ?? path.join(tmpdir(), "clawhub-runner");

interface QueuedRun {
  runId: string;
  repoNs: string;
  repoName: string;
  commit: string;
  pipelineYaml: string;
  runnerToken: string;
  // Standing-agent runs carry an image instead of pipeline steps: the runner runs
  // the BYO container WITH network (to reach an LLM) and the injected agent token
  // + LLM creds (pulled from the gated secrets endpoint). See docs/standing-agents.md.
  standing?: boolean;
  image?: string;
  command?: string;
  timeoutSec?: number;
  memoryMb?: number;
  cpus?: number;
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

async function runShell(cmd: string, cwd: string, env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn("sh", ["-c", cmd], { cwd, env });
    let out = "", err = "";
    child.stdout.on("data", d => out += d.toString());
    child.stderr.on("data", d => err += d.toString());
    child.on("close", code => resolve({ code: code ?? 1, out, err }));
  });
}

/** Spawn a process with a hard wall-clock timeout (SIGKILL on expiry). */
async function runWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { env: process.env });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", d => out += d.toString());
    child.stderr.on("data", d => err += d.toString());
    child.on("close", code => { clearTimeout(timer); resolve({ code: code ?? 1, out, err, timedOut }); });
    child.on("error", e => { clearTimeout(timer); resolve({ code: 1, out, err: err + String((e as Error).message), timedOut }); });
  });
}

/**
 * Run a standing-agent's BYO container against the cloned repo. Unlike CI steps,
 * this gets network (to reach an LLM) and the injected agent token + LLM creds.
 * Secrets are written to a mode-600 env-file (NOT the docker argv, which `ps`
 * leaks) that lives OUTSIDE the mounted workdir and is removed after the run.
 * The container is memory/CPU capped, drops all caps + no-new-privileges, and is
 * wall-clock bounded.
 */
async function runContainer(q: QueuedRun, workdir: string, env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  // Hold the env-file (unsealed agent JWT + LLM key) in its OWN 0700 dir — never
  // the mounted workdir (the container would read it) and never a predictable
  // shared name. mkdtemp gives an unguessable path; chmod 0700 blocks other users.
  const secretsDir = await mkdtemp(path.join(WORKROOT, "secrets-"));
  await chmod(secretsDir, 0o700);
  const envFile = path.join(secretsDir, "env");
  // env-file format is KEY=VALUE per line; values may contain anything except a
  // newline, so collapse CR/LF in injected values to keep one var per line.
  const lines = Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, " ")}`);
  await writeFile(envFile, lines.join("\n"), { mode: 0o600 });

  const timeoutMs = Math.max(60_000, (q.timeoutSec ?? 1800) * 1000);
  const args = [
    "run", "--rm",
    "--network", "bridge",                       // the deliberate exception: LLM egress
    "--memory", `${q.memoryMb ?? 1024}m`,
    "--cpus", String(q.cpus ?? 1),
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--env-file", envFile,
    "-v", `${workdir}:/workspace`, "-w", "/workspace",
  ];
  // A command override forces an `sh -c` entrypoint; otherwise the image's own
  // ENTRYPOINT runs (the documented contract in docs/standing-agents.md).
  if (q.command) args.push("--entrypoint", "sh", q.image!, "-c", q.command);
  else args.push(q.image!);

  try {
    const r = await runWithTimeout("docker", args, timeoutMs);
    if (r.timedOut) return { code: r.code || 124, out: r.out, err: `${r.err}\n[runner] standing run exceeded ${q.timeoutSec ?? 1800}s timeout; killed` };
    return { code: r.code, out: r.out, err: r.err };
  } finally {
    await rm(secretsDir, { recursive: true, force: true });
  }
}

async function fetchSecrets(runId: string, runnerToken: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${BASE}/api/v1/ci/runs/${runId}/secrets`, { headers: { "x-runner-token": runnerToken } });
    if (!res.ok) return {};
    const j = await res.json() as { secrets: Record<string, string> };
    return j.secrets;
  } catch { return {}; }
}

async function reportStatus(runId: string, runnerToken: string, status: "running" | "success" | "failure" | "skipped", body: { logUrl?: string; stepResults?: unknown[] } = {}): Promise<boolean> {
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
        body: JSON.stringify({ runner_token: runnerToken, status, ...body }),
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
    await rm(workdir, { recursive: true, force: true });
    return;
  }

  // --no-single-branch: --depth alone implies single-branch (default branch
  // only), but the commit under test usually lives on a Change branch.
  const cloneResult = await runShell(`git clone --depth 50 --no-single-branch "${cloneUrl}" .`, workdir, process.env as Record<string, string>);
  if (cloneResult.code !== 0) {
    await reportStatus(q.runId, q.runnerToken, "failure", { stepResults: [{ name: "clone", passed: false, exitCode: cloneResult.code, out: "", err: cloneResult.err.slice(-4000) }] });
    await rm(workdir, { recursive: true, force: true });
    return;
  }
  // Failing to land on the requested commit must fail the run — silently
  // testing the wrong commit is worse than no test at all.
  const co = await runShell(`git checkout --detach ${q.commit}`, workdir, process.env as Record<string, string>);
  if (co.code !== 0) {
    await reportStatus(q.runId, q.runnerToken, "failure", { stepResults: [{ name: "checkout", passed: false, exitCode: co.code, out: "", err: co.err.slice(-4000) }] });
    await rm(workdir, { recursive: true, force: true });
    return;
  }

  const secrets = await fetchSecrets(q.runId, q.runnerToken);
  const env = { ...process.env, ...secrets } as Record<string, string>;

  // Standing-agent run: run the BYO container (with network + injected creds)
  // instead of pipeline steps. The container does the inference and pushes any
  // work as a Change through the normal governance flow.
  if (q.standing && q.image) {
    const r = await runContainer(q, workdir, secrets);
    await reportStatus(q.runId, q.runnerToken, r.code === 0 ? "success" : "failure", {
      stepResults: [{ name: "standing-agent", passed: r.code === 0, exitCode: r.code, out: r.out.slice(-8000), err: r.err.slice(-8000) }],
    });
    await rm(workdir, { recursive: true, force: true });
    return;
  }

  const pipeline = parseYaml(q.pipelineYaml);
  const results: Array<{ name?: string; passed: boolean; exitCode: number; out: string; err: string }> = [];
  let failed = false;

  for (const step of pipeline.steps) {
    const r = await runShell(step.run, workdir, env);
    results.push({ name: step.name, passed: r.code === 0, exitCode: r.code, out: r.out.slice(-4000), err: r.err.slice(-4000) });
    if (r.code !== 0) { failed = true; break; }
  }

  await reportStatus(q.runId, q.runnerToken, failed ? "failure" : "success", { stepResults: results });
  await rm(workdir, { recursive: true, force: true });
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
          process.stdout.write(`[runner] running ${q.runId} (${q.repoNs}/${q.repoName}@${q.commit})\n`);
          runOne(q).catch(e => process.stderr.write(`[runner] run failed: ${(e as Error).message}\n`));
        }
      } catch { /* ignore */ }
    }
  }
}

async function main() {
  await mkdir(WORKROOT, { recursive: true });

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
