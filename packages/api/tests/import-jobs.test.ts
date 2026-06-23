import { describe, it, expect } from "vitest";
import { createImportJob, runImportJob } from "../src/services/import-jobs.js";
import type { DB } from "../src/models/db.js";

// Capturing fake DB: insert().values().returning() echoes the row; every
// update().set() is recorded so we can assert the pending → running → terminal
// transitions a poller depends on.
function fakeDb(updates: Array<Record<string, unknown>>): DB {
  return {
    insert: () => ({ values: (v: Record<string, unknown>) => ({ returning: () => Promise.resolve([{ id: "job1", ...v }]) }) }),
    update: () => ({ set: (s: Record<string, unknown>) => ({ where: () => { updates.push(s); return Promise.resolve(); } }) }),
  } as unknown as DB;
}

describe("import-jobs", () => {
  it("createImportJob inserts a pending job", async () => {
    const job = await createImportJob(fakeDb([]), { agentId: "a1", provider: "github", source: "octocat/Hello-World" });
    expect(job).toMatchObject({ id: "job1", agentId: "a1", provider: "github", source: "octocat/Hello-World", status: "pending" });
  });

  it("runImportJob drives running -> success and stores the result + repoId", async () => {
    const updates: Array<Record<string, unknown>> = [];
    await runImportJob(fakeDb(updates), "job1", async () => ({ repoId: "r1", repoName: "Hello-World", branchesImported: 2 }));
    expect(updates[0]).toMatchObject({ status: "running" });
    expect(updates[1]).toMatchObject({ status: "success", repoId: "r1" });
    expect(updates[1].result).toMatchObject({ repoId: "r1", branchesImported: 2 });
  });

  it("runImportJob drives running -> failure on throw, recording the message (never hangs)", async () => {
    const updates: Array<Record<string, unknown>> = [];
    await runImportJob(fakeDb(updates), "job1", async () => { throw new Error("github_404_/repos/x/y"); });
    expect(updates[0]).toMatchObject({ status: "running" });
    expect(updates[1]).toMatchObject({ status: "failure", errorMessage: "github_404_/repos/x/y" });
  });
});
