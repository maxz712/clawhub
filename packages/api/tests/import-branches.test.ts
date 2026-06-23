import { describe, it, expect } from "vitest";
import { recordImportedBranches } from "../src/services/import-common.js";
import type { DB } from "../src/models/db.js";
import type { GitService } from "../src/services/git.js";

// Capturing fake DB: records every branches upsert so we can assert the import
// seeds one row per cloned head. The regression this guards: imports used to
// clone the git data but never write `branches` rows, so the dashboard's code
// browser (which lists branches from the DB) rendered "No code yet".
function fakeDb(captured: Array<{ repoId: string; name: string; headCommit: string }>): DB {
  return {
    insert: () => ({
      values: (v: { repoId: string; name: string; headCommit: string }) => ({
        onConflictDoUpdate: () => { captured.push(v); return Promise.resolve(); },
      }),
    }),
  } as unknown as DB;
}

function fakeGit(branches: Array<{ name: string; headCommit: string }>): GitService {
  return { listBranches: async () => branches } as unknown as GitService;
}

describe("recordImportedBranches", () => {
  it("seeds one branch row per head of the cloned repo", async () => {
    const captured: Array<{ repoId: string; name: string; headCommit: string }> = [];
    const git = fakeGit([{ name: "master", headCommit: "aaa" }, { name: "dev", headCommit: "bbb" }]);
    const n = await recordImportedBranches(fakeDb(captured), git, "repo1", "alice", "Hello-World");
    expect(n).toBe(2);
    expect(captured).toEqual([
      { repoId: "repo1", name: "master", headCommit: "aaa" },
      { repoId: "repo1", name: "dev", headCommit: "bbb" },
    ]);
  });

  it("records nothing (returns 0) when the clone produced no branches", async () => {
    const captured: Array<{ repoId: string; name: string; headCommit: string }> = [];
    const n = await recordImportedBranches(fakeDb(captured), fakeGit([]), "repo1", "alice", "empty");
    expect(n).toBe(0);
    expect(captured).toEqual([]);
  });
});
