/**
 * verify-bench (N3 · gates D7/D9). The qualification instrument for the VERIFY
 * role: a suite of replayed verify plans with KNOWN outcomes, built on M6's plan
 * format (services/verify-plan.ts). A (model, host) candidate for the verify
 * tier authors plans against known specs; those plans are replayed here and the
 * DERIVED attestation checks must match the expected outcome exactly — same
 * kind, same name, same ok. Per D7, admission to the platform catalog's verify
 * role gates on this bench (verify = strict bar; advisory review has the looser
 * reviewer-audit bar); per D8/D9 qualification is per (model, host,
 * quantization), so a catalog entry pins exactly what this bench scored.
 *
 * Counts, not percentages (small-N honesty, same discipline as
 * scripts/reviewer-audit.ts). Exit 0 always — a report, not a gate — EXCEPT a
 * malformed fixture (a plan that fails the real validateVerifyPlan /
 * validateCheckMap, missing/unparseable JSON), which is a bench bug → exit 1.
 *
 *   npx tsx scripts/verify-bench.ts [fixturesDir]        # offline (default)
 *   CLAWHUB_BENCH_URL=http://localhost:3001 npx tsx scripts/verify-bench.ts
 *
 * Fixture format — one directory per case under scripts/verify-bench-fixtures/:
 *   <case>/plan.json             {steps, checkMap} in M6 plan format. Validated
 *                                through the REAL validateVerifyPlan +
 *                                validateCheckMap — the same server code that
 *                                admits a stored plan, so a fixture can never
 *                                drift from what production would accept.
 *   <case>/expected.json         {checks: [{kind, name, ok}]} — the known
 *                                outcome the replay must reproduce.
 *   <case>/recorded-result.json  optional: a browse-result.json recorded from a
 *                                real clawhub-browse run, for offline scoring.
 *
 * Two modes:
 *   OFFLINE (default)            score each case by mapping its
 *                                recorded-result.json through the case's
 *                                checkMap (the same derivation the harness's
 *                                derive_playback_checks performs — see
 *                                packages/agent-harness/entrypoint.sh) and diff
 *                                derived vs expected. No browser, no network,
 *                                CI-safe. A case with no recorded result is
 *                                SKIPped.
 *   LIVE (CLAWHUB_BENCH_URL set) pipe each plan's steps to `clawhub-browse`
 *                                (stdin JSON, --out-dir a temp dir) against the
 *                                app at CLAWHUB_BENCH_URL (relative goto /
 *                                apiCheck targets are resolved against it), read
 *                                the fresh browse-result.json, then score
 *                                identically. If clawhub-browse is not on PATH
 *                                the case is SKIPped with a clear message.
 *
 * Adding a case: mkdir scripts/verify-bench-fixtures/<case>, drop in plan.json
 * + expected.json, then either record a browse-result.json (run the plan once
 * through clawhub-browse and copy the result) for offline scoring, or rely on
 * LIVE mode against a seeded app. A regression case (expected ok:true, recorded
 * ok:false) is a DETECTION test — the bench must flag it FAIL.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCheckMap, validateVerifyPlan, type VerifyStep } from "../src/services/verify-plan.js";

interface StepResult { i: number; step?: string; ok?: boolean; error?: string }
interface BrowseResult {
  steps?: StepResult[];
  apiChecks?: { i: number; url?: string; ok?: boolean; transcript?: string }[];
}
interface Check { kind: string; name: string; ok: boolean; observed?: string }

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(scriptsDir, "verify-bench-fixtures");
const liveUrl = process.env.CLAWHUB_BENCH_URL || "";

/**
 * Derive attestation checks from a browse result × a checkMap. Reimplements
 * derive_playback_checks (packages/agent-harness/entrypoint.sh) with the SAME
 * semantics: for each checkMap key, ok = the step result at that index has
 * ok===true (a missing step result is a failure — the replay never got there);
 * kind/name come from the map. With an EMPTY map, fall back to the same
 * heuristic the harness uses (expect-prefixed / snapshot steps + apiChecks) so a
 * map-less fixture scores the way a map-less plan replays.
 */
function deriveChecks(result: BrowseResult, checkMap: Record<string, { kind: string; name: string }>): Check[] {
  const steps = result.steps ?? [];
  const byIdx = new Map(steps.map(s => [String(s.i), s]));
  const checks: Check[] = [];
  const keys = Object.keys(checkMap);
  if (keys.length) {
    for (const k of keys) {
      const spec = checkMap[k] ?? { kind: "ui", name: `step ${k}` };
      const st = byIdx.get(String(k));
      const c: Check = { kind: spec.kind || "ui", name: spec.name || `step ${k}`, ok: st ? st.ok === true : false };
      if (st?.error) c.observed = String(st.error);
      checks.push(c);
    }
    return checks;
  }
  for (const s of steps) {
    const t = String(s.step ?? "");
    if (/^expect|snapshot/.test(t)) checks.push({ kind: "ui", name: `${t} #${s.i}`, ok: s.ok === true });
  }
  for (const a of result.apiChecks ?? []) {
    checks.push({ kind: "api", name: `api ${a.url}`, ok: a.ok === true, observed: String(a.transcript ?? "").slice(0, 1500) });
  }
  return checks;
}

const fmt = (c: Check) => `{kind:${c.kind}, name:"${c.name}", ok:${c.ok}}`;

/** Exact ordered kind+name+ok diff. Returns [] when derived reproduces expected. */
function diffChecks(derived: Check[], expected: Check[]): string[] {
  const problems: string[] = [];
  for (let i = 0; i < Math.max(derived.length, expected.length); i++) {
    const d = derived[i];
    const e = expected[i];
    if (!d) { problems.push(`check #${i}: MISSING from derived — expected ${fmt(e)}`); continue; }
    if (!e) { problems.push(`check #${i}: EXTRA in derived — ${fmt(d)}`); continue; }
    if (d.kind !== e.kind || d.name !== e.name || d.ok !== e.ok) {
      problems.push(`check #${i}: derived ${fmt(d)} != expected ${fmt(e)}${d.observed ? ` (observed: ${d.observed})` : ""}`);
    }
  }
  return problems;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Resolve a plan's relative goto/apiCheck targets against the live bench URL. */
function absolutizeSteps(steps: VerifyStep[], baseUrl: string): VerifyStep[] {
  const base = baseUrl.replace(/\/$/, "");
  return steps.map(s => {
    if (s.type !== "goto" && s.type !== "apiCheck") return s;
    const target = (s.url ?? s.target) as string | undefined;
    if (typeof target !== "string" || !target.startsWith("/")) return s;
    return { ...s, url: `${base}${target}` };
  });
}

function browseOnPath(): boolean {
  return spawnSync("sh", ["-c", "command -v clawhub-browse"], { stdio: "ignore" }).status === 0;
}

/** LIVE replay: pipe steps to clawhub-browse, read its browse-result.json. */
function replayLive(steps: VerifyStep[]): { result?: BrowseResult; error?: string } {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "verify-bench-"));
  const proc = spawnSync("clawhub-browse", ["--out-dir", outDir], {
    input: JSON.stringify(absolutizeSteps(steps, liveUrl)),
    encoding: "utf8",
    timeout: 120_000,
  });
  // A non-zero exit is a FAILING replay, not a bench error — browse-result.json
  // still carries the per-step outcomes we score. Only a missing result file
  // (spawn blew up before the driver wrote anything) is unscorable.
  const resultFile = path.join(outDir, "browse-result.json");
  if (!existsSync(resultFile)) {
    return { error: `clawhub-browse produced no browse-result.json (exit ${proc.status}): ${(proc.stderr || proc.stdout || "").slice(0, 400)}` };
  }
  return { result: readJson(resultFile) as BrowseResult };
}

type CaseOutcome = { name: string; status: "PASS" | "FAIL" | "SKIP"; detail: string[] };

function runCase(caseDir: string, haveBrowse: boolean): { outcome: CaseOutcome; malformed: boolean } {
  const name = path.basename(caseDir);
  const detail: string[] = [];

  // 1. Load + validate the plan through the REAL server-side validators. A
  //    fixture that production would reject is a bench bug — report loudly.
  const planFile = path.join(caseDir, "plan.json");
  const expectedFile = path.join(caseDir, "expected.json");
  let steps: VerifyStep[];
  let checkMap: Record<string, { kind: string; name: string }>;
  let expected: Check[];
  try {
    const plan = readJson(planFile) as { steps?: unknown; checkMap?: unknown };
    const stepsV = validateVerifyPlan(plan.steps);
    if (!stepsV.ok) return { malformed: true, outcome: { name, status: "FAIL", detail: [`MALFORMED FIXTURE: plan.json fails validateVerifyPlan — ${stepsV.error}`] } };
    steps = stepsV.steps;
    const mapV = validateCheckMap(plan.checkMap, steps);
    if (!mapV.ok) return { malformed: true, outcome: { name, status: "FAIL", detail: [`MALFORMED FIXTURE: plan.json fails validateCheckMap — ${mapV.error}`] } };
    checkMap = mapV.checkMap;
    const exp = readJson(expectedFile) as { checks?: unknown };
    if (!Array.isArray(exp.checks)) return { malformed: true, outcome: { name, status: "FAIL", detail: ["MALFORMED FIXTURE: expected.json must be {checks: [{kind, name, ok}]}"] } };
    expected = exp.checks as Check[];
  } catch (e) {
    return { malformed: true, outcome: { name, status: "FAIL", detail: [`MALFORMED FIXTURE: ${String((e as Error).message ?? e)}`] } };
  }

  // 2. Obtain a browse result — live replay or the recorded one.
  let result: BrowseResult;
  if (liveUrl) {
    if (!haveBrowse) {
      return { malformed: false, outcome: { name, status: "SKIP", detail: [`live mode requested (CLAWHUB_BENCH_URL=${liveUrl}) but clawhub-browse is not on PATH — install the harness CLIs or unset CLAWHUB_BENCH_URL for offline scoring`] } };
    }
    const live = replayLive(steps);
    if (!live.result) return { malformed: false, outcome: { name, status: "SKIP", detail: [`live replay unscorable: ${live.error}`] } };
    result = live.result;
    detail.push(`replayed live against ${liveUrl}`);
  } else {
    const recordedFile = path.join(caseDir, "recorded-result.json");
    if (!existsSync(recordedFile)) {
      return { malformed: false, outcome: { name, status: "SKIP", detail: ["no recorded-result.json — record one or run live with CLAWHUB_BENCH_URL"] } };
    }
    try {
      result = readJson(recordedFile) as BrowseResult;
    } catch (e) {
      return { malformed: true, outcome: { name, status: "FAIL", detail: [`MALFORMED FIXTURE: recorded-result.json — ${String((e as Error).message ?? e)}`] } };
    }
  }

  // 3. Derive checks exactly as playback would, diff against the known outcome.
  const derived = deriveChecks(result, checkMap);
  const problems = diffChecks(derived, expected);
  if (problems.length) {
    return { malformed: false, outcome: { name, status: "FAIL", detail: [...detail, ...problems] } };
  }
  detail.push(`${derived.length} check(s) reproduced the known outcome exactly`);
  return { malformed: false, outcome: { name, status: "PASS", detail } };
}

function main() {
  if (!existsSync(fixturesDir)) {
    console.error(`fixtures directory not found: ${fixturesDir}`);
    process.exit(1);
  }
  const caseDirs = readdirSync(fixturesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(fixturesDir, d.name))
    .sort();
  if (!caseDirs.length) {
    console.error(`no fixture cases under ${fixturesDir}`);
    process.exit(1);
  }

  const haveBrowse = liveUrl ? browseOnPath() : false;
  const mode = liveUrl ? `LIVE (${liveUrl})` : "OFFLINE (recorded results)";
  console.log(`\n=== verify-bench · ${caseDirs.length} case(s) · mode: ${mode} ===\n`);

  let malformedCount = 0;
  const totals = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const dir of caseDirs) {
    const { outcome, malformed } = runCase(dir, haveBrowse);
    if (malformed) malformedCount++;
    totals[outcome.status]++;
    console.log(`  [${outcome.status}] ${outcome.name}`);
    for (const line of outcome.detail) console.log(`         ${line}`);
  }

  console.log(`\nTotals: ${totals.PASS} pass · ${totals.FAIL} fail · ${totals.SKIP} skipped (of ${caseDirs.length})`);
  if (malformedCount) {
    console.error(`\n${malformedCount} MALFORMED fixture(s) — that is a bench bug, not a candidate result. Fix the fixture(s).`);
    process.exit(1);
  }
  console.log("Verify-tier admission (D7/D9) reads these counts: a candidate qualifies only with every case PASS and zero skips on the qualification suite.\n");
  process.exit(0);
}

main();
