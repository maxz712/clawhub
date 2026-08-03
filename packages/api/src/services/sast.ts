import { and, eq, isNull, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { sastFindings, sastRules } from "../models/schema.js";
import type { GitService } from "./git.js";
import { log } from "./logger.js";

// DoS bounds for the synchronous scan (runs in the shared post-push worker).
const MAX_LINE_LEN = 2048;            // truncate any line longer than this before .test()
const MAX_FILE_SCAN_BYTES = 1_000_000; // skip files larger than ~1MB entirely
// File-count bound (#118): matches code-index's MAX_SCAN_FILES, so any realistic
// change scope is scanned in full; a capped scan is flagged `truncated` — never
// silently dropped like the old `.slice(0, 50)`.
export const MAX_SAST_FILES = 2000;
const READ_CHUNK = 200;               // files per cat-file --batch call — bounds memory

export const DEFAULT_RULES: Array<{ identifier: string; pattern: string; flags: string; severity: "low" | "medium" | "high" | "critical"; message: string; languages: string[] }> = [
  { identifier: "hardcoded-aws-key", pattern: "AKIA[0-9A-Z]{16}", flags: "", severity: "critical", message: "Hardcoded AWS access key", languages: [] },
  { identifier: "hardcoded-private-key", pattern: "-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----", flags: "", severity: "critical", message: "Hardcoded private key material", languages: [] },
  { identifier: "sql-string-concat", pattern: "(?:SELECT|INSERT|UPDATE|DELETE)[^;]*\\+\\s*(?:req|params|query|body)\\.", flags: "i", severity: "high", message: "SQL string concatenation with user input — potential SQL injection", languages: ["ts", "js", "py"] },
  { identifier: "js-eval", pattern: "\\beval\\s*\\(", flags: "", severity: "high", message: "Use of eval()", languages: ["ts", "js"] },
  { identifier: "child-process-exec", pattern: "child_process\\.exec\\s*\\(\\s*[`'\"][^`'\"]*\\$\\{", flags: "", severity: "high", message: "Shell command with template-string interpolation — command injection risk", languages: ["ts", "js"] },
  { identifier: "python-yaml-load", pattern: "yaml\\.load\\(", flags: "", severity: "high", message: "yaml.load is unsafe; use yaml.safe_load", languages: ["py"] },
  { identifier: "insecure-http", pattern: "http:\\/\\/(?!localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)", flags: "", severity: "low", message: "Plaintext HTTP URL", languages: [] },
  { identifier: "md5-usage", pattern: "\\bMD5\\b|createHash\\(\\s*['\"]md5['\"]\\s*\\)", flags: "", severity: "medium", message: "MD5 is cryptographically weak", languages: [] },
  { identifier: "missing-cors-check", pattern: "Access-Control-Allow-Origin.*\\*", flags: "", severity: "medium", message: "Wildcard CORS — ensure this is intentional", languages: [] },
];

export async function seedDefaultRules(db: DB): Promise<void> {
  for (const r of DEFAULT_RULES) {
    // These are GLOBAL rules (repoId null). The unique index is on
    // (repo_id, identifier) and Postgres treats NULLs as DISTINCT, so
    // onConflictDoNothing never matches a NULL-repo row — without this guard a
    // boot-time seed would re-insert every rule on every boot (duplicate rules →
    // duplicate findings). Check-then-insert keeps it idempotent.
    const existing = (await db.select({ id: sastRules.id }).from(sastRules)
      .where(and(isNull(sastRules.repoId), eq(sastRules.identifier, r.identifier))).limit(1))[0];
    if (existing) continue;
    await db.insert(sastRules).values({
      identifier: r.identifier,
      pattern: r.pattern,
      flags: r.flags,
      severity: r.severity,
      message: r.message,
      languages: r.languages,
    });
  }
}

function langFromPath(p: string): string | null {
  const ext = p.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  const map: Record<string, string> = { ts: "ts", tsx: "ts", mts: "ts", cts: "ts", js: "js", jsx: "js", mjs: "js", cjs: "js", py: "py", go: "go", rs: "rs", java: "java", rb: "rb", php: "php" };
  return map[ext] ?? null;
}

export interface SastScanResult {
  findings: number;
  /** Files considered (bounded by MAX_SAST_FILES). */
  scannedFiles: number;
  truncated: boolean;
}

export async function scanChange(db: DB, git: GitService, input: { namespace: string; repo: string; repoId: string; changeId: string; base: string; head: string; scope: string[] }): Promise<SastScanResult> {
  const toScan = input.scope.slice(0, MAX_SAST_FILES);
  const truncated = input.scope.length > toScan.length;
  if (truncated) log("warn", "sast_scan_truncated", { repoId: input.repoId, changeId: input.changeId, filesScanned: toScan.length, scopeTotal: input.scope.length, cap: MAX_SAST_FILES });

  // Load applicable rules (repo-specific or global).
  const rules = await db.select().from(sastRules).where(and(or(isNull(sastRules.repoId), eq(sastRules.repoId, input.repoId))!, eq(sastRules.enabled, true)));
  if (rules.length === 0) return { findings: 0, scannedFiles: toScan.length, truncated };

  // Compile each rule's tester ONCE (non-global so .test() is stateless per call
  // and there's no per-line `new RegExp` allocation).
  const compiled = rules.map(r => ({
    rule: r,
    re: safeRegExp(r.pattern, r.flags.includes("i") ? "i" : ""),
  })).filter(c => c.re !== null) as Array<{ rule: typeof rules[number]; re: RegExp }>;

  let total = 0;
  for (let c = 0; c < toScan.length; c += READ_CHUNK) {
    const contents = await git.filesAt(input.namespace, input.repo, input.head, toScan.slice(c, c + READ_CHUNK));
    for (const [p, content] of contents) {
      const lang = langFromPath(p);
      if (!content) continue;
      // ReDoS / DoS bound: cap the bytes scanned per file and the bytes fed to each
      // regex .test(). A pathological pattern stalls the shared post-push event loop,
      // so we (a) skip files larger than MAX_FILE_SCAN_BYTES and (b) truncate any
      // line over MAX_LINE_LEN before testing. Normal source lines are well under 2KB,
      // so this preserves matching behavior for legitimate rules.
      if (content.length > MAX_FILE_SCAN_BYTES) continue;
      const lines = content.split(/\r?\n/);
      for (const { rule, re } of compiled) {
        const langs = rule.languages as string[];
        if (langs.length && lang && !langs.includes(lang)) continue;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].length > MAX_LINE_LEN ? lines[i].slice(0, MAX_LINE_LEN) : lines[i];
          if (re.test(line)) {
            await db.insert(sastFindings).values({
              repoId: input.repoId,
              changeId: input.changeId,
              ruleId: rule.id,
              path: p,
              line: i + 1,
              excerpt: lines[i].slice(0, 240),
              severity: rule.severity,
            });
            total++;
          }
        }
      }
    }
  }
  return { findings: total, scannedFiles: toScan.length, truncated };
}

function safeRegExp(pattern: string, flags: string): RegExp | null {
  try { return new RegExp(pattern, flags); } catch { return null; }
}
