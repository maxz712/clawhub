import { describe, it, expect } from "vitest";
import { resolveReleaseTarget } from "../src/routes/releases.js";
import { changes, branches } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

// GAP 4 — releases no longer require a changeId. A release may be cut from a tag
// + an optional commit (default: the repo's default-branch HEAD). When changeId
// IS given, the old contract holds (must be a merged Change in this repo).

interface ChangeRow { id: string; repoId: string; status: string; }
interface BranchRow { repoId: string; name: string; headCommit: string; }

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
      if (k === "table") continue;
      walk((x as Record<string, unknown>)[k]);
    }
  };
  walk(cond);
  return out;
}

function makeFakeDb(world: { changes: ChangeRow[]; branches: BranchRow[] }): DB {
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows: Array<Record<string, unknown>> = table === changes ? world.changes : table === branches ? world.branches : [];
        let filtered = rows.slice();
        const chain = {
          where: (cond: unknown) => {
            const lits = conditionLiterals(cond);
            filtered = filtered.filter(r => {
              if (table === changes) return lits.includes(String(r.id)) && lits.includes(String(r.repoId));
              if (table === branches) return lits.includes(String(r.repoId)) && lits.includes(String(r.name));
              return false;
            });
            return chain;
          },
          limit: (_n: number) => Promise.resolve(filtered.slice(0, _n)),
          then: (res: (v: unknown[]) => void) => res(filtered),
        };
        return chain as typeof chain & PromiseLike<unknown[]>;
      },
    }),
  };
  return db as unknown as DB;
}

const world = {
  changes: [
    { id: "ch-merged", repoId: "repo1", status: "merged" },
    { id: "ch-open", repoId: "repo1", status: "pending" },
  ],
  branches: [
    { repoId: "repo1", name: "main", headCommit: "abc123head" },
  ],
};

describe("resolveReleaseTarget", () => {
  it("requires a tag", async () => {
    const db = makeFakeDb(world);
    await expect(resolveReleaseTarget(db, { repoId: "repo1", defaultBranch: "main" })).rejects.toThrow(/tag required/);
  });

  it("defaults the commit to the default-branch HEAD when no changeId/commit given", async () => {
    const db = makeFakeDb(world);
    const { changeId, commit } = await resolveReleaseTarget(db, { repoId: "repo1", defaultBranch: "main", tag: "v1.0.0" });
    expect(changeId).toBeNull();
    expect(commit).toBe("abc123head");
  });

  it("honors an explicit commit over the branch HEAD", async () => {
    const db = makeFakeDb(world);
    const { changeId, commit } = await resolveReleaseTarget(db, { repoId: "repo1", defaultBranch: "main", tag: "v1.1.0", commit: "deadbeef" });
    expect(changeId).toBeNull();
    expect(commit).toBe("deadbeef");
  });

  it("keeps the old contract when a changeId is given (merged Change in repo)", async () => {
    const db = makeFakeDb(world);
    const { changeId, commit } = await resolveReleaseTarget(db, { repoId: "repo1", defaultBranch: "main", tag: "v1.2.0", changeId: "ch-merged" });
    expect(changeId).toBe("ch-merged");
    // commit still resolves to HEAD for the event payload
    expect(commit).toBe("abc123head");
  });

  it("rejects an unmerged changeId", async () => {
    const db = makeFakeDb(world);
    await expect(resolveReleaseTarget(db, { repoId: "repo1", defaultBranch: "main", tag: "v1.3.0", changeId: "ch-open" }))
      .rejects.toThrow(/merged change/);
  });

  it("404s an unknown changeId", async () => {
    const db = makeFakeDb(world);
    await expect(resolveReleaseTarget(db, { repoId: "repo1", defaultBranch: "main", tag: "v1.4.0", changeId: "nope" }))
      .rejects.toThrow();
  });
});
