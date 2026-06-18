import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitService } from "../src/services/git.js";
import { readRepoPipelines, syncRepoPipelines, upsertRepoPipeline } from "../src/services/ci.js";
import type { DB } from "../src/models/db.js";

// GAP 3 — CI as config-as-code. Pipelines defined under .clawhub/ci/*.yml (or
// .clawhub/ci.yml) at the default-branch commit are picked up and upserted.

const NS = "ci-ns";
const REPO = "ci-repo";

let base: string;
let git: GitService;
let head: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "clawhub-ci-asode-"));
  git = new GitService(path.join(base, "repos"));
  await git.initBare(NS, REPO);

  const work = path.join(base, "work");
  await mkdir(work);
  const g = simpleGit(work);
  await g.init(["-b", "main"]);
  await g.addConfig("user.name", "t").then(() => g.addConfig("user.email", "t@t"));
  await mkdir(path.join(work, ".clawhub", "ci"), { recursive: true });
  // Directory form, name from the `name:` field.
  await writeFile(path.join(work, ".clawhub", "ci", "tests.yml"),
    "name: unit\non: push\nsteps:\n  - run: npm test\n");
  // Directory form, name falls back to the filename stem (no `name:`).
  await writeFile(path.join(work, ".clawhub", "ci", "deploy.yaml"),
    "on: merge\nsteps:\n  - run: ./deploy.sh\n");
  // A schedule pipeline with a valid cron.
  await writeFile(path.join(work, ".clawhub", "ci", "nightly.yml"),
    "name: nightly\non: schedule\ncron: \"0 3 * * *\"\nsteps:\n  - run: npm run e2e\n");
  // A schedule pipeline with NO cron — must be skipped (inert, not a push gate).
  await writeFile(path.join(work, ".clawhub", "ci", "broken.yml"),
    "name: broken\non: schedule\nsteps:\n  - run: echo hi\n");
  await g.add(".");
  await g.commit("seed ci");
  await g.push([git.pathOf(NS, REPO), "main"]);
  head = await git.headCommit(NS, REPO, "main");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

// Minimal fake DB recording inserts/updates against ci_pipelines. The fake
// honors the (repoId, name) existing-row lookup by pulling the literal param
// values out of the Drizzle condition tree, so a sync that inserts several
// pipelines doesn't mistake an earlier insert for an "existing" match.
interface Row { id: string; repoId: string; name: string; yaml: string; enabled: boolean; triggerKind: string; triggerConfig: Record<string, unknown>; }

function conditionLiterals(cond: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (x: unknown) => {
    if (!x || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    const cname = (x as { constructor?: { name?: string } }).constructor?.name;
    const val = (x as { value?: unknown }).value;
    if (cname === "Param" && (typeof val === "string" || typeof val === "number")) out.push(String(val));
    for (const k of Object.keys(x as object)) {
      if (k === "table") continue; // don't descend into circular table defs
      walk((x as Record<string, unknown>)[k]);
    }
  };
  walk(cond);
  return out;
}

function makeFakeDb(rows: Row[]): DB {
  let seq = 0;
  const db = {
    select: () => ({
      from: (_t: unknown) => {
        let filtered = rows.slice();
        const chain = {
          where: (cond: unknown) => {
            const lits = conditionLiterals(cond);
            // Keep only rows whose repoId AND name appear among the literals.
            filtered = filtered.filter(r => lits.includes(r.repoId) && lits.includes(r.name));
            return chain;
          },
          limit: (_n: number) => Promise.resolve(filtered.slice(0, _n)),
          then: (res: (v: unknown[]) => void) => res(filtered),
        };
        return chain as typeof chain & PromiseLike<unknown[]>;
      },
    }),
    insert: (_t: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        const row: Row = { id: `p${++seq}`, repoId: String(vals.repoId), name: String(vals.name), yaml: String(vals.yaml), enabled: Boolean(vals.enabled), triggerKind: String(vals.triggerKind), triggerConfig: (vals.triggerConfig as Record<string, unknown>) ?? {} };
        rows.push(row);
        return { returning: () => Promise.resolve([row]) };
      },
    }),
    update: (_t: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const lits = conditionLiterals(cond);
          for (const r of rows) {
            if (lits.includes(r.id)) Object.assign(r, vals);
          }
          return Promise.resolve([]);
        },
      }),
    }),
  };
  return db as unknown as DB;
}

describe("readRepoPipelines", () => {
  it("reads every .clawhub/ci/*.yml and resolves names", async () => {
    const files = await readRepoPipelines(git, NS, REPO, head);
    const names = files.map(f => f.name).sort();
    expect(names).toEqual(["broken", "deploy", "nightly", "unit"]);
    // name from the YAML `name:` field
    expect(files.find(f => f.name === "unit")!.yaml).toContain("npm test");
    // name from the filename stem when `name:` is absent
    expect(files.find(f => f.name === "deploy")!.yaml).toContain("./deploy.sh");
  });
});

describe("upsertRepoPipeline", () => {
  it("persists a push pipeline with the derived trigger", async () => {
    const rows: Row[] = [];
    const db = makeFakeDb(rows);
    const ok = await upsertRepoPipeline(db, "repo1", { name: "unit", yaml: "on: push\nsteps:\n  - run: npm test\n" });
    expect(ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("unit");
    expect(rows[0].triggerKind).toBe("push");
    expect(rows[0].enabled).toBe(true);
  });

  it("derives a schedule trigger with cron config", async () => {
    const rows: Row[] = [];
    const db = makeFakeDb(rows);
    const ok = await upsertRepoPipeline(db, "repo1", { name: "nightly", yaml: "on: schedule\ncron: \"0 3 * * *\"\nsteps: []\n" });
    expect(ok).toBe(true);
    expect(rows[0].triggerKind).toBe("schedule");
    expect((rows[0].triggerConfig as { cron?: string }).cron).toBe("0 3 * * *");
  });

  it("skips a schedule pipeline with no cron (inert, not a push gate)", async () => {
    const rows: Row[] = [];
    const db = makeFakeDb(rows);
    const ok = await upsertRepoPipeline(db, "repo1", { name: "broken", yaml: "on: schedule\nsteps: []\n" });
    expect(ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("skips an event pipeline with no event type", async () => {
    const rows: Row[] = [];
    const db = makeFakeDb(rows);
    const ok = await upsertRepoPipeline(db, "repo1", { name: "fan", yaml: "on: event\nsteps: []\n" });
    expect(ok).toBe(false);
    expect(rows).toHaveLength(0);
  });
});

describe("syncRepoPipelines", () => {
  it("picks up in-repo pipeline files and upserts the valid ones", async () => {
    const rows: Row[] = [];
    const db = makeFakeDb(rows);
    const synced = await syncRepoPipelines(db, git, NS, REPO, "repo1", head);
    // 'broken' (schedule, no cron) is skipped; the other three are upserted.
    expect(synced.sort()).toEqual(["deploy", "nightly", "unit"]);
    expect(rows.map(r => r.name).sort()).toEqual(["deploy", "nightly", "unit"]);
    expect(rows.find(r => r.name === "deploy")!.triggerKind).toBe("merge");
    expect(rows.find(r => r.name === "nightly")!.triggerKind).toBe("schedule");
  });
});
