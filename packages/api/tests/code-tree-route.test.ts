import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { Hono } from "hono";
import { GitService } from "../src/services/git.js";
import { createCodeRoutes, splitRefPath } from "../src/routes/code.js";
import { agents, organizations, repositories, branches } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

process.env.JWT_SECRET ??= "test-secret-code-tree";
const { signToken } = await import("../src/services/auth.js");
const TOKEN = signToken({ kind: "user", userId: "u1", email: "t@t" });
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

// GAP 7a — the GitHub-style path-based tree route. The dashboard renders URLs
// like /repos/:ns/:repo/tree/main and a direct API request to
// /api/v1/repos/:ns/:repo/tree/main/ used to 404. These tests assert the
// path-based route now serves the repo root at a ref (including the trailing
// slash / empty-path case) and a subdirectory, alongside the query-param form.

const NS = "alice";
const REPO = "demo";

let base: string;
let git: GitService;
let app: Hono;

// Single-repo fake DB: returns the one canned row per table regardless of the
// (opaque) condition — the test world holds exactly one namespace/repo/branch.
function makeFakeDb(): DB {
  const world = {
    agents: [{ id: "ag1", name: NS }],
    organizations: [] as unknown[],
    repositories: [{ id: "repo1", name: REPO, namespaceType: "agent", namespaceId: "ag1", defaultBranch: "main" }],
    branches: [{ repoId: "repo1", name: "main", headCommit: "x" }, { repoId: "repo1", name: "feature/x", headCommit: "y" }],
  };
  const rowsFor = (t: unknown): unknown[] => {
    if (t === agents) return world.agents;
    if (t === organizations) return world.organizations;
    if (t === repositories) return world.repositories;
    if (t === branches) return world.branches;
    return [];
  };
  const db = {
    select: (_cols?: unknown) => ({
      from: (t: unknown) => {
        const rows = rowsFor(t);
        const chain = {
          where: (_c: unknown) => chain,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          then: (res: (v: unknown[]) => void) => res(rows),
        };
        return chain as typeof chain & PromiseLike<unknown[]>;
      },
    }),
  };
  return db as unknown as DB;
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "clawhub-code-route-"));
  git = new GitService(path.join(base, "repos"));
  await git.initBare(NS, REPO);

  const work = path.join(base, "work");
  await mkdir(work);
  const g = simpleGit(work);
  await g.init(["-b", "main"]);
  await g.addConfig("user.name", "t").then(() => g.addConfig("user.email", "t@t"));
  await mkdir(path.join(work, "src"));
  await writeFile(path.join(work, "README.md"), "# hi\n");
  await writeFile(path.join(work, "src", "index.ts"), "export {}\n");
  await g.add(".");
  await g.commit("seed");
  await g.push([git.pathOf(NS, REPO), "main"]);
  // A branch with a slash to exercise greedy ref/path splitting.
  await g.checkoutLocalBranch("feature/x");
  await writeFile(path.join(work, "src", "feat.ts"), "export const f = 1\n");
  await g.add(".");
  await g.commit("feat");
  await g.push([git.pathOf(NS, REPO), "feature/x"]);

  // Mount the real route with a no-op auth middleware (auth is orthogonal here).
  const routes = createCodeRoutes(makeFakeDb(), git);
  app = new Hono();
  app.route("/api/v1/repos", routes);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("splitRefPath", () => {
  it("splits a plain ref + path", () => {
    expect(splitRefPath("main/src", ["main"])).toEqual({ ref: "main", path: "src" });
  });
  it("handles the bare-ref root case", () => {
    expect(splitRefPath("main", ["main"])).toEqual({ ref: "main", path: "" });
    expect(splitRefPath("main/", ["main"])).toEqual({ ref: "main", path: "" });
  });
  it("greedily matches a slash-containing branch name", () => {
    expect(splitRefPath("feature/x/src/feat.ts", ["main", "feature/x"])).toEqual({ ref: "feature/x", path: "src/feat.ts" });
  });
  it("falls back to first segment for an unknown ref (SHA/tag)", () => {
    expect(splitRefPath("abc123/src", ["main"])).toEqual({ ref: "abc123", path: "src" });
  });
});

describe("GET /tree (path form)", () => {
  it("serves the repo root for /tree/main (bare ref, no path)", async () => {
    const res = await app.request(`/api/v1/repos/${NS}/${REPO}/tree/main`, auth);
    expect(res.status).toBe(200);
    const json = await res.json() as { ref: string; path: string; entries: Array<{ name: string }> };
    expect(json.ref).toBe("main");
    expect(json.path).toBe("");
    expect(json.entries.map(e => e.name).sort()).toEqual(["README.md", "src"]);
  });

  it("serves the repo root for /tree/main/ (trailing slash — the reported 404)", async () => {
    const res = await app.request(`/api/v1/repos/${NS}/${REPO}/tree/main/`, auth);
    expect(res.status).toBe(200);
    const json = await res.json() as { ref: string; path: string; entries: Array<{ name: string }> };
    expect(json.ref).toBe("main");
    expect(json.path).toBe("");
    expect(json.entries.length).toBe(2);
  });

  it("serves a subdirectory for /tree/main/src", async () => {
    const res = await app.request(`/api/v1/repos/${NS}/${REPO}/tree/main/src`, auth);
    expect(res.status).toBe(200);
    const json = await res.json() as { entries: Array<{ name: string }> };
    expect(json.entries.map(e => e.name)).toEqual(["index.ts"]);
  });

  it("resolves a slash-containing branch greedily for /tree/feature/x/src", async () => {
    const res = await app.request(`/api/v1/repos/${NS}/${REPO}/tree/feature/x/src`, auth);
    expect(res.status).toBe(200);
    const json = await res.json() as { ref: string; path: string; entries: Array<{ name: string }> };
    expect(json.ref).toBe("feature/x");
    expect(json.path).toBe("src");
    expect(json.entries.map(e => e.name).sort()).toEqual(["feat.ts", "index.ts"]);
  });
});

describe("GET /tree (query form still works)", () => {
  it("serves root via ?ref=main", async () => {
    const res = await app.request(`/api/v1/repos/${NS}/${REPO}/tree?ref=main`, auth);
    expect(res.status).toBe(200);
    const json = await res.json() as { entries: Array<{ name: string }> };
    expect(json.entries.length).toBe(2);
  });
  it("serves a subdirectory via ?ref=main&path=src", async () => {
    const res = await app.request(`/api/v1/repos/${NS}/${REPO}/tree?ref=main&path=src`, auth);
    expect(res.status).toBe(200);
    const json = await res.json() as { entries: Array<{ name: string }> };
    expect(json.entries.map(e => e.name)).toEqual(["index.ts"]);
  });
});
