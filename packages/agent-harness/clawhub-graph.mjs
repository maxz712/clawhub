#!/usr/bin/env node
// clawhub-graph — OFFLINE code-structure map via graphify (tree-sitter), for the
// ClawHub memory GRAPH layer. Runs `graphify extract` on the checkout, parses the
// resulting graph.json DEFENSIVELY (its schema is not contractual), and prints a
// COMPACT map of the most-connected files + how they connect — material the agent
// turns into memory->code (`about`) and memory->memory (`relates_to`) edges via the
// write API. Best-effort BY DESIGN: ANY failure prints nothing and exits 0, so the
// caller (develop/reflect) simply falls back to reading the code itself. Nothing
// leaves the sandbox (code extraction needs no network/LLM). See docs/memory.md.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Absolute so graphify (run from a temp cwd) resolves it correctly + writes
// graphify-out under the real target, not the temp dir.
const TARGET = resolve(process.argv[2] || process.env.CLAWHUB_GRAPH_TARGET || "/workspace");
const TIMEOUT_MS = Number(process.env.CLAWHUB_GRAPH_TIMEOUT_SEC || 120) * 1000;
const MAX_FILES = Number(process.env.CLAWHUB_GRAPH_MAX_FILES || 25);
const MAX_NBRS = 6;
const MAX_CHARS = Number(process.env.CLAWHUB_GRAPH_MAX_CHARS || 2400);

function fail() { process.exit(0); } // print nothing, NEVER error the run

// graphify must be present; otherwise degrade silently.
const probe = spawnSync("graphify", ["--help"], { timeout: 15000 });
if (probe.error) fail();

// Extract from a TEMP cwd so graphify-out/ never lands in /workspace (which the
// harness `git add -A`s). Look for graph.json in the likely locations either way.
let workdir;
try { workdir = mkdtempSync(join(tmpdir(), "clawhub-graph-")); } catch { fail(); }
spawnSync("graphify", ["extract", TARGET], { cwd: workdir, timeout: TIMEOUT_MS, stdio: ["ignore", "ignore", "ignore"] });
// (ignore exit status — even a partial graph.json is useful.)

const graphPath = [
  join(workdir, "graphify-out", "graph.json"),
  join(TARGET, "graphify-out", "graph.json"),
  join(workdir, "graph.json"),
].find(p => { try { return existsSync(p); } catch { return false; } });
if (!graphPath) fail();

let data;
try { data = JSON.parse(readFileSync(graphPath, "utf8")); } catch { fail(); }

// Defensive shape handling: nodes[] + edges[]|links[] (graphify / d3 style).
const rawNodes = Array.isArray(data.nodes) ? data.nodes : (Array.isArray(data?.graph?.nodes) ? data.graph.nodes : []);
const rawEdges = Array.isArray(data.edges) ? data.edges : (Array.isArray(data.links) ? data.links : (Array.isArray(data?.graph?.edges) ? data.graph.edges : []));
if (!rawNodes.length) fail();

const looksLikePath = s => typeof s === "string" && (s.includes("/") || /\.[a-z]{1,5}$/i.test(s));
const idOf = n => (n && (n.id ?? n.name ?? n.label ?? n.source_file ?? n.path)) ?? null;
// graphify keys the repo-relative file on `source_file` (e.g. "pkg/a.ts"); try it
// FIRST so we aggregate by full path, not the bare `label` basename. Other keys are
// defensive fallbacks for schema drift / other producers.
const pathOf = n => {
  for (const c of [n?.source_file, n?.path, n?.file, n?.filepath, n?.data?.path, n?.label, n?.name, n?.id]) {
    if (looksLikePath(c)) return String(c);
  }
  return null;
};

// Index nodes by string id AND positional index (d3-style links reference indices).
const nodesById = new Map();
rawNodes.forEach((n, i) => {
  const id = idOf(n);
  if (id != null) nodesById.set(String(id), n);
  nodesById.set(String(i), n);
});
const endpoints = e => {
  const norm = v => (v && typeof v === "object") ? String(idOf(v) ?? "") : String(v ?? "");
  return [norm(e?.source ?? e?.from ?? e?.src), norm(e?.target ?? e?.to ?? e?.dst)];
};

// Degree + adjacency over file-ish nodes only.
const degree = new Map();
const nbrs = new Map();
const link = (p) => { let s = nbrs.get(p); if (!s) { s = new Set(); nbrs.set(p, s); } return s; };
for (const e of rawEdges) {
  const [a, b] = endpoints(e);
  const pa = pathOf(nodesById.get(a)), pb = pathOf(nodesById.get(b));
  if (!pa || !pb || pa === pb) continue;
  degree.set(pa, (degree.get(pa) || 0) + 1);
  degree.set(pb, (degree.get(pb) || 0) + 1);
  link(pa).add(pb); link(pb).add(pa);
}
if (!degree.size) fail();

const top = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_FILES);
const lines = top.map(([file, deg]) => `- ${file} (${deg}) -> ${[...(nbrs.get(file) || [])].slice(0, MAX_NBRS).join(", ")}`);
let out = "Most-connected files (from graphify; file -> files it connects to):\n" + lines.join("\n");
if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + "\n- ...";
process.stdout.write(out + "\n");
