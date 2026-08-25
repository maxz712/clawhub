import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The production image installs runtime deps for THIS workspace only:
//   npm install --omit=dev --ignore-scripts --workspace @clawhub/api --include-workspace-root
// so a bare import that resolves in the monorepo dev tree — where every
// workspace's transitive deps are hoisted into one root node_modules — can be
// ABSENT in prod. tsc, vitest and CI all run in the dev tree, so nothing else
// catches it: the API simply crash-loops on ERR_MODULE_NOT_FOUND at boot.
//
// That is not hypothetical. `import { Agent } from "undici"` (services/url-guard.ts)
// shipped green through tsc + 42 tests + push-CI and took production down —
// undici reached the tree only via the Expo mobile workspace
// (@clawhub/mobile → expo-router → @expo/server → @remix-run/node → undici),
// which the prod image does not install.
//
// This test is the cheap check that closes that gap: every bare specifier the
// API imports must be declared in packages/api/package.json.

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

/** Bare specifiers Node resolves without any package (builtins imported unprefixed). */
const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "dns", "events", "fs", "http",
  "https", "net", "os", "path", "stream", "string_decoder", "timers", "tls",
  "url", "util", "worker_threads", "zlib",
]);

/**
 * Only real import/export/dynamic-import forms — never a `from "..."` that
 * happens to appear inside a template literal or a comment (the API ships prose
 * like `... set to the default` in error strings, which a naive scan flags).
 */
const SPEC_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s*["']([^"']+)["']|(?:^|[^.\w])import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function packageOf(spec: string): string {
  return spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function undeclaredIn(dir: string): Map<string, string[]> {
  const bad = new Map<string, string[]>();
  for (const file of walk(dir)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("#")) continue;
      const name = packageOf(spec);
      if (NODE_BUILTINS.has(name) || declared.has(name)) continue;
      bad.set(name, [...(bad.get(name) ?? []), file.slice(pkgRoot.length + 1)]);
    }
  }
  return bad;
}

describe("every bare import the API ships is a declared dependency", () => {
  it("src/ imports only packages declared in packages/api/package.json", () => {
    const bad = undeclaredIn(join(pkgRoot, "src"));
    // Named explicitly so the failure says WHICH module and WHERE, and why it
    // matters — a reader hitting this should not have to rediscover the outage.
    expect(
      Object.fromEntries(bad),
      "Undeclared runtime import(s). These resolve in the monorepo dev tree but are ABSENT from the production image (it installs the api workspace only), so the API crash-loops at boot. Add them to packages/api/package.json dependencies.",
    ).toEqual({});
  });

  it("declares undici, the import that caused the boot-crash regression", () => {
    // A targeted pin: url-guard.ts's safeFetch needs undici's Agent for
    // connect.lookup IP pinning, and nothing else in the api closure provides it.
    expect(declared.has("undici")).toBe(true);
  });
});
