#!/usr/bin/env node
// Fail the build if anything in packages/api/src statically imports from @clawhub/api-ee.
// Dynamic imports (await import("@clawhub/api-ee")) are allowed — that's how app.ts
// loads the cloud edition behind the CLAWHUB_EDITION flag.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const apiSrc = join(__dirname, "..", "packages", "api", "src");

const STATIC_IMPORT_RX = /^\s*import\s+[^;]*from\s+["']@clawhub\/api-ee(?:\/[^"']*)?["']/m;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(apiSrc)) {
  const src = readFileSync(file, "utf8");
  if (STATIC_IMPORT_RX.test(src)) offenders.push(file);
}

if (offenders.length) {
  console.error("[boundary] core (packages/api/src) must not statically import @clawhub/api-ee:");
  for (const f of offenders) console.error("  " + f);
  console.error("Use `await import(\"@clawhub/api-ee\")` inside the `edition === 'cloud'` branch instead.");
  process.exit(1);
}

console.log("[boundary] ok — no static @clawhub/api-ee imports in core.");
