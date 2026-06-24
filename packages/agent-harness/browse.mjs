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
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    else if (k === "--timeout") a.timeout = Number(argv[++i]);
  }
  return a;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function loadSteps(a) {
  if (a.script) return JSON.parse(await readFile(a.script, "utf8"));
  if (a.steps) return JSON.parse(a.steps);
  if (process.env.CLAWHUB_BROWSE_STEPS) return JSON.parse(process.env.CLAWHUB_BROWSE_STEPS);
  const stdin = await readStdin();
  if (stdin) return JSON.parse(stdin);
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

  const [vw, vh] = (a.viewport || "1280x800").split("x").map(Number);
  const consoleErrors = [];
  const stepLog = [];
  const screenshots = [];
  let ok = true;

  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext({ viewport: { width: vw || 1280, height: vh || 800 }, ignoreHTTPSErrors: true });
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
    const result = { ok: ok && consoleErrors.length === 0 ? true : ok, hadConsoleErrors: consoleErrors.length > 0, finalUrl, screenshots, steps: stepLog, consoleErrors: consoleErrors.slice(0, 20) };
    // Also drop a machine-readable result next to the screenshots.
    await writeFile(path.join(a.outDir, "browse-result.json"), JSON.stringify(result, null, 2)).catch(() => {});
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

run().catch(e => { process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }) + "\n"); process.exit(1); });
