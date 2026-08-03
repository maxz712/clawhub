import { describe, it, expect } from "vitest";
import { scanRepoHead, MAX_MANIFEST_FILES } from "../src/services/dep-scan.js";
import { scanChange, MAX_SAST_FILES } from "../src/services/sast.js";
import { generateSbom } from "../src/services/sbom.js";
import { issues, vulnAdvisories, vulnFindings, sastRules, sastFindings } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";
import type { GitService } from "../src/services/git.js";

// Regression tests for #118: the security scanners used to hard-slice their file
// set (dep-scan 20 / SAST 50 / SBOM 30) and report success with no truncation
// signal, so findings in files past the cap silently escaped detection. The fix
// mirrors #109 (code search): scan everything up to a far-larger bound, and flag
// `truncated` + warn when the bound is hit — never report success while having
// silently skipped files.

function fakeGit(files: Record<string, string>): GitService {
  return {
    open: () => ({ raw: async () => Object.keys(files).join("\n") }),
    filesAt: async (_ns: string, _repo: string, _commit: string, paths: string[]) =>
      new Map(paths.filter(p => files[p] !== undefined).map(p => [p, files[p]])),
    fileAt: async (_ns: string, _repo: string, _commit: string, p: string) => files[p] ?? null,
  } as unknown as GitService;
}

interface Inserted { issues: any[]; vulnFindings: any[]; sastFindings: any[]; sbomExports: any[] }

function fakeDb(state: { advisories?: any[]; rules?: any[] } = {}): DB & { _inserted: Inserted } {
  const inserted: Inserted = { issues: [], vulnFindings: [], sastFindings: [], sbomExports: [] };
  const db = {
    _inserted: inserted,
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: (_w: unknown) => {
          if (table === vulnAdvisories) return Promise.resolve(state.advisories ?? []);
          if (table === sastRules) return Promise.resolve(state.rules ?? []);
          if (table === issues) return Promise.resolve([{ m: inserted.issues.length }]);
          return Promise.resolve([]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        const bucket = table === issues ? inserted.issues
          : table === vulnFindings ? inserted.vulnFindings
          : table === sastFindings ? inserted.sastFindings
          : inserted.sbomExports;
        const row = { id: `row-${bucket.length + 1}`, ...v };
        bucket.push(row);
        return {
          returning: () => Promise.resolve([row]),
          onConflictDoNothing: () => Promise.resolve([]),
          then: (res: (rows: unknown[]) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve([row]).then(res, rej),
        };
      },
    }),
  };
  return db as unknown as DB & { _inserted: Inserted };
}

const LODASH_ADVISORY = {
  id: "adv1",
  ecosystem: "npm",
  packageName: "lodash",
  identifier: "GHSA-xxxx",
  vulnerableRange: "<4.17.21",
  patchedRange: ">=4.17.21",
  severity: "critical",
  summary: "Prototype pollution in lodash",
  url: null,
};

describe("dep-scan file-set bound (#118)", () => {
  it("detects a vulnerable dep in a manifest past the old 20-file cap and auto-files the issue", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 25; i++) {
      const n = String(i).padStart(2, "0");
      files[`packages/pkg${n}/package.json`] = i === 24
        ? JSON.stringify({ dependencies: { lodash: "4.17.11" } })
        : "{}";
    }
    files["README.md"] = "not a manifest";
    const db = fakeDb({ advisories: [LODASH_ADVISORY] });
    const res = await scanRepoHead(db, fakeGit(files), {
      namespace: "ns", repo: "r", repoId: "repo1", commit: "c1",
      openIssueCreator: { kind: "human", id: "u1" },
    });
    expect(res.findings).toBe(1);
    expect(res.truncated).toBe(false);
    expect(res.scanned).toBe(25); // files considered, not deps parsed
    expect(db._inserted.vulnFindings).toHaveLength(1);
    expect(db._inserted.vulnFindings[0].manifestPath).toBe("packages/pkg24/package.json");
    expect(db._inserted.issues).toHaveLength(1); // critical → auto-filed [security] issue
    expect(db._inserted.issues[0].title).toContain("GHSA-xxxx");
  });

  it("flags truncation when the retained large bound is hit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_MANIFEST_FILES + 20; i++) {
      files[`packages/pkg${String(i).padStart(4, "0")}/package.json`] = "{}";
    }
    const db = fakeDb();
    const res = await scanRepoHead(db, fakeGit(files), {
      namespace: "ns", repo: "r", repoId: "repo1", commit: "c1", openIssueCreator: null,
    });
    expect(res.truncated).toBe(true);
    expect(res.scanned).toBe(MAX_MANIFEST_FILES);
  });
});

describe("SAST file-set bound (#118)", () => {
  const EVAL_RULE = {
    id: "r1", repoId: null, identifier: "js-eval", pattern: "\\beval\\s*\\(", flags: "",
    severity: "high", message: "Use of eval()", languages: ["ts", "js"], enabled: true,
  };

  it("flags a hit in a file past the old 50-file cap", async () => {
    const files: Record<string, string> = {};
    const scope: string[] = [];
    for (let i = 0; i < 55; i++) {
      const p = `src/f${String(i).padStart(3, "0")}.ts`;
      scope.push(p);
      files[p] = i === 52 ? "eval('2+2')" : "const x = 1;";
    }
    const db = fakeDb({ rules: [EVAL_RULE] });
    const res = await scanChange(db, fakeGit(files), {
      namespace: "ns", repo: "r", repoId: "repo1", changeId: "ch1", base: "main", head: "h1", scope,
    });
    expect(res.findings).toBe(1);
    expect(res.truncated).toBe(false);
    expect(res.scannedFiles).toBe(55);
    expect(db._inserted.sastFindings[0].path).toBe("src/f052.ts");
  });

  it("flags truncation when the change scope exceeds the retained bound", async () => {
    const scope = Array.from({ length: MAX_SAST_FILES + 10 }, (_, i) => `src/f${i}.ts`);
    const db = fakeDb({ rules: [EVAL_RULE] });
    const res = await scanChange(db, fakeGit({}), {
      namespace: "ns", repo: "r", repoId: "repo1", changeId: "ch1", base: "main", head: "h1", scope,
    });
    expect(res.truncated).toBe(true);
    expect(res.scannedFiles).toBe(MAX_SAST_FILES);
  });
});

describe("SBOM manifest bound (#118)", () => {
  it("includes dependencies from manifests past the old 30-file cap, with no truncation comment", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 35; i++) {
      const n = String(i).padStart(2, "0");
      files[`packages/pkg${n}/package.json`] = i === 33
        ? JSON.stringify({ dependencies: { leftpad: "1.0.0" } })
        : "{}";
    }
    const db = fakeDb();
    const doc = await generateSbom(db, fakeGit(files), {
      namespace: "ns", repo: "r", repoId: "repo1", commit: "c1", releaseId: "rel1", releaseTag: "v1",
    });
    expect(doc.packages.some(p => p.name === "leftpad")).toBe(true);
    expect(doc.creationInfo.comment).toBeUndefined();
    expect(db._inserted.sbomExports).toHaveLength(1);
  });

  it("stamps an INCOMPLETE comment into the document when the bound is hit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_MANIFEST_FILES + 5; i++) {
      files[`packages/pkg${String(i).padStart(4, "0")}/package.json`] = "{}";
    }
    const db = fakeDb();
    const doc = await generateSbom(db, fakeGit(files), {
      namespace: "ns", repo: "r", repoId: "repo1", commit: "c1", releaseId: "rel1", releaseTag: "v1",
    });
    expect(doc.creationInfo.comment).toContain("INCOMPLETE");
  });
});
