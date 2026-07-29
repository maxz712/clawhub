#!/usr/bin/env node
/**
 * clawhub-browse — the harness's browser hands.
 *
 * A deterministic Playwright/Chromium driver an agent uses to TEST a UI it built
 * and capture screenshot EVIDENCE. ClawHub never runs the model; the model
 * decides WHAT to click and WHERE to look, then calls this to actually do it.
 *
 * It runs a small JSON "script" of steps (goto / click / fill / waitFor /
 * screenshot / expectText) against a URL — normally the app the agent just
 * started inside its own sandbox on http://localhost:<port>, so the whole UI test
 * happens with zero internet. When the agent does navigate off-box, Chromium is
 * pointed at the egress proxy (HTTPS_PROXY), so navigation is subject to the same
 * allowlist as everything else — the browser cannot escape the sandbox either.
 *
 * Usage:
 *   clawhub-browse --url http://localhost:3000 --out screenshot.png
 *   clawhub-browse --script steps.json --out-dir /workspace/.clawhub-evidence
 *   echo '<json steps>' | clawhub-browse --out-dir /workspace/.clawhub-evidence
 *
 * Prints a JSON result to stdout: { ok, finalUrl, screenshots[], steps[], consoleErrors[] }.
 * Exit code is non-zero if any expectText assertion failed or a step errored.
 */

import { chromium } from "playwright";
import { mkdir, readFile, writeFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const a = { outDir: "/workspace/.clawhub-evidence" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--url") a.url = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--out-dir") a.outDir = argv[++i];
    else if (k === "--script") a.script = argv[++i];
    else if (k === "--steps") a.steps = argv[++i];
    else if (k === "--viewport") a.viewport = argv[++i];           // e.g. 1280x800
    else if (k === "--video") a.video = true;                       // record session → outDir/verify.webm
    else if (k === "--timeout") a.timeout = Number(argv[++i]);
    else if (k === "--token") a.token = argv[++i];                 // user JWT → localStorage.clawhub_token
    else if (k === "--user") a.user = argv[++i];                   // user record JSON → localStorage.clawhub_user
  }
  return a;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// The server's plan whitelist (services/verify-plan.ts) authors steps in a
// TYPE-KEYED shape — {type:"goto", url:"/x"} — while this driver dispatches on
// key PRESENCE (step.goto). Without translation a replayed plan executes NOTHING
// (and {type:"goto"} would even be misread as a keystroke by the step.type
// branch). Normalize type-keyed plan steps into the key-presence shape here so a
// stored plan replays for real. Legacy key-presence steps + the {type:selector}
// keystroke shorthand (type is a selector, not a known step type) pass through.
const STEP_TYPES = new Set(["goto", "click", "fill", "screenshot", "snapshot", "waitFor", "expectText", "expectVisible", "expectUrl", "expectValue", "expectCount", "expectStyle", "apiCheck"]);
function normalizeStep(s) {
  if (!s || typeof s !== "object" || typeof s.type !== "string" || !STEP_TYPES.has(s.type)) return s;
  const t = s.type;
  switch (t) {
    case "goto": return { goto: s.url ?? s.target, waitUntil: s.waitUntil };
    case "click": return { click: s.selector ?? s.click };
    case "fill": return { fill: s.selector ?? s.fill, value: s.value };
    case "waitFor": return { waitFor: s.selector ?? s.waitFor };
    case "screenshot": return { screenshot: s.path ?? s.name ?? "screenshot.png", fullPage: s.fullPage };
    case "snapshot": return { snapshot: s.selector ?? true, expectText: s.expectText };
    case "expectText": return { expectText: s.text ?? s.value ?? s.expectText };
    case "expectVisible": return { expectVisible: s.selector ?? s.expectVisible };
    case "expectUrl": return { expectUrl: s.url ?? s.value ?? s.expectUrl, exact: s.exact };
    case "expectValue": return { expectValue: s.selector ?? s.expectValue, value: s.value };
    case "expectCount": return { expectCount: s.selector ?? s.expectCount, value: s.value };
    case "expectStyle": return { expectStyle: s.selector ?? s.expectStyle, prop: s.prop, value: s.value, tolerance: s.tolerance };
    case "apiCheck": return { apiCheck: s.url ?? s.target, method: s.method, body: s.body, headers: s.headers, expectStatus: s.expectStatus, expectBodyIncludes: s.expectBodyIncludes };
    default: return s;
  }
}
function normalizeSteps(steps) { return Array.isArray(steps) ? steps.map(normalizeStep) : steps; }

async function loadSteps(a) {
  if (a.script) return normalizeSteps(JSON.parse(await readFile(a.script, "utf8")));
  if (a.steps) return normalizeSteps(JSON.parse(a.steps));
  if (process.env.CLAWHUB_BROWSE_STEPS) return normalizeSteps(JSON.parse(process.env.CLAWHUB_BROWSE_STEPS));
  const stdin = await readStdin();
  if (stdin) return normalizeSteps(JSON.parse(stdin));
  // Shorthand: just goto a URL and screenshot it.
  if (a.url) return [{ goto: a.url }, { screenshot: a.out || "screenshot.png", fullPage: true }];
  throw new Error("no steps: pass --url, --script, --steps, or pipe JSON on stdin");
}

function launchOptions() {
  // Route the browser through the egress proxy when one is present, so external
  // navigation is allow/deny-decided exactly like the agent's other traffic.
  // localhost (the in-sandbox app under test) bypasses the proxy.
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const opts = { args: ["--no-sandbox", "--disable-dev-shm-usage"] };
  // `<-loopback>` is Chromium's token to exclude ALL loopback addresses from the
  // proxy — without it Chromium routes even localhost through the proxy (which
  // can't see the in-sandbox app). The app under test is always reached directly.
  if (proxyServer) opts.proxy = { server: proxyServer, bypass: "<-loopback>,localhost,127.0.0.1,::1" };
  return opts;
}

async function run() {
  const a = parseArgs(process.argv.slice(2));
  const steps = await loadSteps(a);
  await mkdir(a.outDir, { recursive: true });

  // 1920×1080 default (M6): a realistic desktop viewport so expectVisible/layout
  // checks match what a human sees. Override with --viewport WxH.
  // #56: verify.yml may pin a viewport for the whole run (e.g. 375x812 mobile);
  // the harness exports it as CLAWHUB_BROWSE_VIEWPORT. Explicit --viewport wins.
  const [vw, vh] = (a.viewport || process.env.CLAWHUB_BROWSE_VIEWPORT || "1920x1080").split("x").map(Number);
  const consoleErrors = [];
  const stepLog = [];
  const screenshots = [];
  const apiChecks = [];   // in-driver request transcripts (kind: api evidence)
  const snapshots = [];   // accessibility/innerText snapshots
  let ok = true;

  // Numeric tolerance compare for expectStyle (e.g. "16px" within ±2px).
  const styleMatches = (actual, expected, tolerance) => {
    const na = parseFloat(actual), ne = parseFloat(expected);
    if (Number.isFinite(na) && Number.isFinite(ne) && (tolerance ?? 0) >= 0 && /px|em|rem|%$/.test(String(expected))) {
      return Math.abs(na - ne) <= (tolerance ?? 0);
    }
    return String(actual).trim() === String(expected).trim();
  };

  const browser = await chromium.launch(launchOptions());
  // #57: verify.yml `video: true` → CLAWHUB_BROWSE_VIDEO=1 → Playwright records
  // the session; the file is finalized when the browser closes and staged as
  // outDir/verify.webm below so the harness can attach it as review evidence.
  const wantVideo = a.video || process.env.CLAWHUB_BROWSE_VIDEO === "1";
  const ctx = await browser.newContext({
    viewport: { width: vw || 1280, height: vh || 800 }, ignoreHTTPSErrors: true,
    ...(wantVideo ? { recordVideo: { dir: a.outDir, size: { width: vw || 1280, height: vh || 800 } } } : {}),
  });

  // Authenticated browsing. The dashboard gates every app route on
  // localStorage.clawhub_token (dashboard/src/lib/auth.ts: isLoggedIn). With no
  // session, the (app) layout bounces EVERY route to /login — so without this a
  // verifier could only ever screenshot the sign-in page, never the change it is
  // supposed to test. Inject a fresh test-user token (passed via --token or
  // CLAWHUB_BROWSE_TOKEN, seeded by the harness) into localStorage BEFORE any page
  // script runs, so the app boots already logged in.
  const authToken = a.token || process.env.CLAWHUB_BROWSE_TOKEN;
  const authUser = a.user || process.env.CLAWHUB_BROWSE_USER;
  if (authToken) {
    await ctx.addInitScript(({ t, u }) => {
      try {
        localStorage.setItem("clawhub_token", t);
        if (u) localStorage.setItem("clawhub_user", u);
      } catch { /* about:blank / opaque origin has no localStorage — ignore */ }
    }, { t: authToken, u: authUser });
  }

  const page = await ctx.newPage();
  page.setDefaultTimeout(a.timeout || 15000);
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", e => consoleErrors.push(String(e)));

  try {
    for (const [i, step] of steps.entries()) {
      const label = Object.keys(step)[0];
      try {
        if (step.goto) await page.goto(step.goto, { waitUntil: step.waitUntil || "networkidle" });
        else if (step.click !== undefined) await page.click(step.click);
        else if (step.fill !== undefined) await page.fill(step.fill, String(step.value ?? ""));
        else if (step.type !== undefined) await page.type(step.type, String(step.value ?? ""));
        else if (step.press !== undefined) await page.press(step.selector || "body", step.press);
        else if (step.waitFor !== undefined) await page.waitForSelector(step.waitFor);
        else if (step.waitForTimeout !== undefined) await page.waitForTimeout(Number(step.waitForTimeout));
        else if (step.screenshot !== undefined) {
          const file = path.isAbsolute(step.screenshot) ? step.screenshot : path.join(a.outDir, step.screenshot);
          await page.screenshot({ path: file, fullPage: step.fullPage !== false });
          screenshots.push(file);
        } else if (step.expectText !== undefined) {
          const body = await page.textContent("body").catch(() => "");
          const found = (body || "").includes(step.expectText);
          if (!found) { ok = false; stepLog.push({ i, step: "expectText", value: step.expectText, ok: false }); continue; }
        } else if (step.snapshot !== undefined) {
          // Accessibility snapshot + innerText fallback (M6). A cheap, text-first
          // way to assert structure without a screenshot on every turn.
          const sel = typeof step.snapshot === "string" ? step.snapshot : "body";
          const ax = await page.accessibility.snapshot({ interestingOnly: true }).catch(() => null);
          const text = await page.textContent(sel).catch(() => "");
          const snap = { i, url: page.url(), ax, text: (text || "").slice(0, 4000) };
          snapshots.push(snap);
          if (step.expectText && !(text || "").includes(step.expectText)) { ok = false; stepLog.push({ i, step: "snapshot", ok: false, error: `text missing: ${step.expectText}` }); continue; }
        } else if (step.expectVisible !== undefined) {
          const visible = await page.isVisible(step.expectVisible).catch(() => false);
          if (!visible) { ok = false; stepLog.push({ i, step: "expectVisible", selector: step.expectVisible, ok: false }); continue; }
        } else if (step.expectUrl !== undefined) {
          const cur = page.url();
          const matches = step.exact ? cur === step.expectUrl : cur.includes(step.expectUrl);
          if (!matches) { ok = false; stepLog.push({ i, step: "expectUrl", expected: step.expectUrl, actual: cur, ok: false }); continue; }
        } else if (step.expectValue !== undefined) {
          const val = await page.inputValue(step.selector || step.expectValue).catch(() => null);
          if (val !== String(step.value ?? "")) { ok = false; stepLog.push({ i, step: "expectValue", selector: step.selector || step.expectValue, expected: step.value, actual: val, ok: false }); continue; }
        } else if (step.expectCount !== undefined) {
          const n = await page.locator(step.expectCount).count().catch(() => -1);
          if (n !== Number(step.value)) { ok = false; stepLog.push({ i, step: "expectCount", selector: step.expectCount, expected: step.value, actual: n, ok: false }); continue; }
        } else if (step.expectStyle !== undefined) {
          // Computed-style assertion with px tolerance (M6). {expectStyle, prop, value, tolerance?}
          const actual = await page.$eval(step.expectStyle, (el, prop) => getComputedStyle(el)[prop], step.prop).catch(() => null);
          if (actual == null || !styleMatches(actual, step.value, step.tolerance)) { ok = false; stepLog.push({ i, step: "expectStyle", selector: step.expectStyle, prop: step.prop, expected: step.value, actual, ok: false }); continue; }
        } else if (step.apiCheck !== undefined) {
          // In-driver HTTP request with a recorded transcript (M6) — an `api` claim
          // backed by a real request/response, restricted to the app under test.
          const method = (step.method || "GET").toUpperCase();
          const started = Date.now();
          const resp = await page.request.fetch(step.apiCheck, { method, data: step.body, headers: step.headers, timeout: a.timeout || 15000 }).catch(e => ({ __err: String(e && e.message || e) }));
          const status = resp && resp.status ? resp.status() : 0;
          const bodyText = (resp && resp.text) ? (await resp.text().catch(() => "")).slice(0, 2000) : (resp && resp.__err) || "";
          const transcript = `${method} ${step.apiCheck} → ${status}\n${bodyText}`;
          let stepOk = true;
          if (step.expectStatus != null && status !== Number(step.expectStatus)) stepOk = false;
          if (step.expectBodyIncludes && !bodyText.includes(step.expectBodyIncludes)) stepOk = false;
          apiChecks.push({ i, url: step.apiCheck, method, status, transcript, ok: stepOk });
          if (!stepOk) { ok = false; stepLog.push({ i, step: "apiCheck", url: step.apiCheck, status, ok: false }); continue; }
        }
        stepLog.push({ i, step: label, ok: true });
      } catch (e) {
        ok = false;
        stepLog.push({ i, step: label, ok: false, error: String(e && e.message || e) });
        // Capture a failure screenshot for debugging evidence, then stop.
        try {
          const file = path.join(a.outDir, `error-step-${i}.png`);
          await page.screenshot({ path: file, fullPage: true });
          screenshots.push(file);
        } catch { /* ignore */ }
        break;
      }
    }
    const finalUrl = page.url();
    const result = { ok: ok && consoleErrors.length === 0 ? true : ok, hadConsoleErrors: consoleErrors.length > 0, finalUrl, screenshots, steps: stepLog, apiChecks, snapshots, consoleErrors: consoleErrors.slice(0, 20) };
    // Also drop a machine-readable result next to the screenshots. run_verify reads
    // browse-result.json × the plan's checkMap to derive attestation checks on playback.
    await writeFile(path.join(a.outDir, "browse-result.json"), JSON.stringify(result, null, 2)).catch(() => {});
    // Full trace (M6): the ordered step log + api transcripts + snapshots + errors,
    // for post-hoc debugging of a failed playback.
    await writeFile(path.join(a.outDir, "trace.json"), JSON.stringify({ finalUrl, steps: stepLog, apiChecks, snapshots, consoleErrors, screenshots }, null, 2)).catch(() => {});
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
    // #57: recordings finalize on close — surface the newest one under a stable name.
    if (wantVideo) {
      try {
        const files = (await readdir(a.outDir)).filter(f => f.endsWith(".webm") && f !== "verify.webm");
        if (files.length) {
          const newest = (await Promise.all(files.map(async f => ({ f, t: (await stat(path.join(a.outDir, f))).mtimeMs }))))
            .sort((x, y) => y.t - x.t)[0];
          await rename(path.join(a.outDir, newest.f), path.join(a.outDir, "verify.webm"));
        }
      } catch { /* best-effort */ }
    }
  }
}

run().catch(e => { process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }) + "\n"); process.exit(1); });
