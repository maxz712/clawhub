import { and, eq, isNull, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { sastFindings, sastRules } from "../models/schema.js";
import type { GitService } from "./git.js";

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
    await db.insert(sastRules).values({
      identifier: r.identifier,
      pattern: r.pattern,
      flags: r.flags,
      severity: r.severity,
      message: r.message,
      languages: r.languages,
    }).onConflictDoNothing();
  }
}

function langFromPath(p: string): string | null {
  const ext = p.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  const map: Record<string, string> = { ts: "ts", tsx: "ts", mts: "ts", cts: "ts", js: "js", jsx: "js", mjs: "js", cjs: "js", py: "py", go: "go", rs: "rs", java: "java", rb: "rb", php: "php" };
  return map[ext] ?? null;
}

export async function scanChange(db: DB, git: GitService, input: { namespace: string; repo: string; repoId: string; changeId: string; base: string; head: string; scope: string[] }): Promise<number> {
  // Load applicable rules (repo-specific or global).
  const rules = await db.select().from(sastRules).where(and(or(isNull(sastRules.repoId), eq(sastRules.repoId, input.repoId))!, eq(sastRules.enabled, true)));
  if (rules.length === 0) return 0;

  // Compile regex once.
  const compiled = rules.map(r => ({
    rule: r,
    re: safeRegExp(r.pattern, r.flags.includes("i") ? "gi" : "g"),
  })).filter(c => c.re !== null) as Array<{ rule: typeof rules[number]; re: RegExp }>;

  let total = 0;
  for (const p of input.scope.slice(0, 50)) {
    const lang = langFromPath(p);
    const content = await git.fileAt(input.namespace, input.repo, input.head, p);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (const { rule, re } of compiled) {
      const langs = rule.languages as string[];
      if (langs.length && lang && !langs.includes(lang)) continue;
      re.lastIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp(rule.pattern, rule.flags.includes("i") ? "i" : "").test(lines[i])) {
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
  return total;
}

function safeRegExp(pattern: string, flags: string): RegExp | null {
  try { return new RegExp(pattern, flags); } catch { return null; }
}
