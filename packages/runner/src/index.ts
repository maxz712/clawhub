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
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
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
  const workdir = await mkdtemp(path.join(WORKROOT, "run-"));
  await mkdir(workdir, { recursive: true });
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

  const pipeline = parseYaml(q.pipelineYaml);
  const secrets = await fetchSecrets(q.runId, q.runnerToken);
  const env = { ...process.env, ...secrets } as Record<string, string>;

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

async function main() {
  await mkdir(WORKROOT, { recursive: true });

  // Subscribe to ci.run.queued via SSE and pick up work.
  const sseUrl = `${BASE}/api/v1/events/stream${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
  process.stdout.write(`[runner] subscribing to ${sseUrl}\n`);

  const res = await fetch(sseUrl, { headers: { accept: "text/event-stream" } });
  if (!res.body) throw new Error("no sse body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
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

void main().catch(e => { process.stderr.write(`[runner] fatal: ${(e as Error).message}\n`); process.exit(1); });
