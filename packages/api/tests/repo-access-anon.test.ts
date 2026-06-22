import { describe, it, expect } from "vitest";
import { repoAccessFor } from "../src/services/repo-access.js";
import type { DB } from "../src/models/db.js";

// The anonymous (null caller) branch of repoAccessFor is the security-critical
// addition for the public browse surface: a no-token request may read a PUBLIC
// repo and gets "none" (→ 404 upstream, no existence leak) for a PRIVATE one.
// That branch returns before touching the db, so a throwing stub proves it never
// queries — and that the gate is purely repo.isPublic.
const throwingDb = new Proxy({}, {
  get() { throw new Error("repoAccessFor(null caller) must not touch the database"); },
}) as unknown as DB;

function repo(isPublic: boolean) {
  return { id: "r1", name: "demo", isPublic, namespaceType: "user", namespaceId: "u1" } as never;
}

describe("repoAccessFor — anonymous caller", () => {
  it("grants read on a public repo without a db query", async () => {
    expect(await repoAccessFor(throwingDb, repo(true), null)).toBe("read");
  });

  it("denies a private repo (none) without a db query — no existence leak", async () => {
    expect(await repoAccessFor(throwingDb, repo(false), null)).toBe("none");
  });
});
