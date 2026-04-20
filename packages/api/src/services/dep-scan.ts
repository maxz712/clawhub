import { and, eq, inArray, max } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { issues, vulnAdvisories, vulnFindings } from "../models/schema.js";
import type { GitService } from "./git.js";

export interface Dependency {
  ecosystem: "npm" | "pypi" | "crates" | "go" | "maven";
  name: string;
  version: string;
  manifestPath: string;
}

export function parseManifest(path: string, content: string): Dependency[] {
  if (path.endsWith("package.json")) return parsePackageJson(path, content);
  if (path.endsWith("requirements.txt")) return parseRequirements(path, content);
  if (path.endsWith("Cargo.toml")) return parseCargo(path, content);
  if (path.endsWith("go.mod")) return parseGoMod(path, content);
  return [];
}

function parsePackageJson(path: string, content: string): Dependency[] {
  try {
    const j = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const out: Dependency[] = [];
    for (const [name, v] of Object.entries({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) })) {
      out.push({ ecosystem: "npm", name, version: cleanRange(v), manifestPath: path });
    }
    return out;
  } catch { return []; }
}

function parseRequirements(path: string, content: string): Dependency[] {
  const out: Dependency[] = [];
  for (const line of content.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, "").trim();
    if (!clean) continue;
    const m = clean.match(/^([A-Za-z0-9_\-.]+)\s*(?:==|>=|<=|~=|!=)\s*([A-Za-z0-9_\-.+*]+)/);
    if (m) out.push({ ecosystem: "pypi", name: m[1], version: m[2], manifestPath: path });
  }
  return out;
}

function parseCargo(path: string, content: string): Dependency[] {
  const out: Dependency[] = [];
  const lines = content.split(/\r?\n/);
  let inDeps = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) inDeps = trimmed === "[dependencies]" || trimmed === "[dev-dependencies]";
    else if (inDeps) {
      const m = trimmed.match(/^([A-Za-z0-9_\-]+)\s*=\s*"?([0-9][0-9A-Za-z_\-.+]*)"?/);
      if (m) out.push({ ecosystem: "crates", name: m[1], version: m[2], manifestPath: path });
    }
  }
  return out;
}

function parseGoMod(path: string, content: string): Dependency[] {
  const out: Dependency[] = [];
  const lines = content.split(/\r?\n/);
  let inRequire = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("require (")) { inRequire = true; continue; }
    if (inRequire && line === ")") { inRequire = false; continue; }
    if (inRequire || line.startsWith("require ")) {
      const m = line.replace(/^require\s+/, "").match(/^([A-Za-z0-9_\-./]+)\s+v([A-Za-z0-9_\-.+]+)/);
      if (m) out.push({ ecosystem: "go", name: m[1], version: m[2], manifestPath: path });
    }
  }
  return out;
}

function cleanRange(v: string): string {
  return v.replace(/^[\^~]/, "").split(" ")[0];
}

// Naive semver-ish check: range is "<x.y.z" or ">=a,<b" or exact "x.y.z".
function matches(range: string, version: string): boolean {
  if (!range || !version) return false;
  for (const part of range.split(/[, ]+/).filter(Boolean)) {
    const m = part.match(/^(<=|>=|<|>|=|==)?\s*([0-9A-Za-z_\-.+]+)$/);
    if (!m) continue;
    const op = m[1] ?? "==";
    const cmp = semverCompare(version, m[2]);
    if (op === "<" && !(cmp < 0)) return false;
    if (op === "<=" && !(cmp <= 0)) return false;
    if (op === ">" && !(cmp > 0)) return false;
    if (op === ">=" && !(cmp >= 0)) return false;
    if ((op === "=" || op === "==") && !(cmp === 0)) return false;
  }
  return true;
}

function semverCompare(a: string, b: string): number {
  const pa = a.split(/[.+\-]/).map(s => Number.isFinite(+s) ? +s : s);
  const pb = b.split(/[.+\-]/).map(s => Number.isFinite(+s) ? +s : s);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    return String(av) < String(bv) ? -1 : 1;
  }
  return 0;
}

const MANIFEST_FILES = ["package.json", "requirements.txt", "Cargo.toml", "go.mod"];

export async function scanRepoHead(db: DB, git: GitService, input: { namespace: string; repo: string; repoId: string; commit: string; openIssueCreator: { kind: "agent" | "human" | "system"; id: string } | null }): Promise<{ scanned: number; findings: number }> {
  const ls = await git.open(input.namespace, input.repo).raw(["ls-tree", "-r", "--name-only", input.commit]).catch(() => "");
  const files = ls.split("\n").filter(Boolean).filter(p => MANIFEST_FILES.some(m => p.endsWith(m) || p === m));

  const deps: Dependency[] = [];
  for (const p of files.slice(0, 20)) {
    const content = await git.fileAt(input.namespace, input.repo, input.commit, p);
    if (content) deps.push(...parseManifest(p, content));
  }

  if (deps.length === 0) return { scanned: 0, findings: 0 };

  // For each dep, find advisories and create findings.
  const advisories = await db.select().from(vulnAdvisories).where(inArray(vulnAdvisories.packageName, Array.from(new Set(deps.map(d => d.name)))));
  let findings = 0;
  for (const d of deps) {
    const relevant = advisories.filter(a => a.ecosystem === d.ecosystem && a.packageName === d.name && matches(a.vulnerableRange, d.version));
    for (const adv of relevant) {
      // Auto-create issue for critical/high if none exists yet.
      let issueId: string | null = null;
      if ((adv.severity === "critical" || adv.severity === "high") && input.openIssueCreator) {
        const nextNumRow = await db.select({ m: max(issues.number) }).from(issues).where(eq(issues.repoId, input.repoId));
        const number = (nextNumRow[0]?.m ?? 0) + 1;
        const [issueRow] = await db.insert(issues).values({
          repoId: input.repoId,
          number,
          title: `[security] ${adv.identifier}: ${adv.packageName}@${d.version} — ${adv.summary.slice(0, 80)}`,
          body: `Advisory: ${adv.identifier}\nSeverity: ${adv.severity}\nPackage: ${adv.packageName}\nInstalled: ${d.version}\nManifest: ${d.manifestPath}\nPatched: ${adv.patchedRange ?? "—"}\n\n${adv.summary}\n\n${adv.url ?? ""}`,
          labels: ["security", "dependencies", adv.severity],
          priority: adv.severity === "critical" ? "urgent" : "high",
          createdByKind: "system",
          createdById: "00000000-0000-0000-0000-000000000000",
        }).returning();
        issueId = issueRow.id;
      }
      await db.insert(vulnFindings).values({
        repoId: input.repoId,
        advisoryId: adv.id,
        manifestPath: d.manifestPath,
        installedVersion: d.version,
        issueId,
      }).onConflictDoNothing();
      findings++;
    }
  }

  return { scanned: deps.length, findings };
}
