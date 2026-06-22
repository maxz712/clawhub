import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { Hono } from "hono";
import { GitService } from "../src/services/git.js";
import { createPublicRepoRoutes } from "../src/routes/public-repos.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { agents, organizations, repositories, branches, changes, issues } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

// End-to-end check of the ANONYMOUS public repo browse surface. The whole point
// of Batch 2 is: a logged-out visitor reads a PUBLIC repo with no token, while a
// PRIVATE repo 404s for anyone anonymous (no existence leak). This also proves
// the route mounting — createPublicRepoRoutes at /api/v1/public/repos must NOT
// shadow the og.svg route that public.ts mounts under /api/v1/public, and the
// `:ref{.+}` tree route must coexist with the sibling param routes.

const NS = "alice";
const REPO = "demo";

// Single-repo fake DB whose repo visibility is parameterized. For an anonymous
// caller, repoAccessFor returns before touching the db (isPublic gate only), so
// the only queries that run resolve the namespace + repo + branches + (empty)
// changes/issues. Returns the one canned row per table regardless of condition.
function makeFakeDb(isPublic: boolean): DB {
  const world = {
    agents: [{ id: "ag1", name: NS }],
    organizations: [] as unknown[],
    repositories: [{
      id: "repo1", name: REPO, namespaceType: "agent", namespaceId: "ag1", defaultBranch: "main",
      isPublic, description: "demo repo", forkOfRepoId: null, topics: [], language: "ts",
      starsCount: 3, watchersCount: 1, createdAt: new Date(), updatedAt: new Date(),
    }],
    branches: [{ repoId: "repo1", name: "main", headCommit: "x" }],
    changes: [] as unknown[],
    issues: [] as unknown[],
  };
  const rowsFor = (t: unknown): unknown[] => {
    if (t === agents) return world.agents;
    if (t === organizations) return world.organizations;
    if (t === repositories) return world.repositories;
    if (t === branches) return world.branches;
    if (t === changes) return world.changes;
    if (t === issues) return world.issues;
    return [];
  };
  const db = {
    select: (_cols?: unknown) => ({
      from: (t: unknown) => {
        const rows = rowsFor(t);
        const chain = {
          where: (_c: unknown) => chain,
          orderBy: (_c: unknown) => chain,
          groupBy: (_c: unknown) => chain,
          innerJoin: (_t: unknown, _c: unknown) => chain,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          then: (res: (v: unknown[]) => void) => res(rows),
        };
        return chain as typeof chain & PromiseLike<unknown[]>;
      },
    }),
  };
  return db as unknown as DB;
}

let base: string;
let git: GitService;

function makeApp(isPublic: boolean): Hono {
  const app = new Hono();
  // Mirror app.ts mount order: public.ts (with the og.svg route) is mounted at
  // /api/v1/public BEFORE the public repo routes at /api/v1/public/repos.
  const ogApp = new Hono();
  ogApp.get("/repos/:ns/:repo/og.svg", c => c.text("OG"));
  app.route("/api/v1/public", ogApp);
  app.route("/api/v1/public/repos", createPublicRepoRoutes(makeFakeDb(isPublic), git));
  app.onError(errorHandler);
  return app;
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "clawhub-public-route-"));
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
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("public repo routes — anonymous read of a PUBLIC repo", () => {
  const app = () => makeApp(true);

  it("serves repo metadata with no token", async () => {
    const res = await app().request(`/api/v1/public/repos/${NS}/${REPO}`);
    expect(res.status).toBe(200);
    const json = await res.json() as { repo: { name: string; isPublic: boolean; namespaceName: string } };
    expect(json.repo.name).toBe(REPO);
    expect(json.repo.isPublic).toBe(true);
    expect(json.repo.namespaceName).toBe(NS);
  });

  it("serves the tree (path form) with no token", async () => {
    const res = await app().request(`/api/v1/public/repos/${NS}/${REPO}/tree/main`);
    expect(res.status).toBe(200);
    const json = await res.json() as { entries: Array<{ name: string }> };
    expect(json.entries.map(e => e.name).sort()).toEqual(["README.md", "src"]);
  });

  it("serves a blob with no token", async () => {
    const res = await app().request(`/api/v1/public/repos/${NS}/${REPO}/blob?ref=main&path=README.md`);
    expect(res.status).toBe(200);
    const json = await res.json() as { content: string };
    expect(json.content).toContain("# hi");
  });

  it("serves the rendered README with no token", async () => {
    const res = await app().request(`/api/v1/public/repos/${NS}/${REPO}/readme`);
    expect(res.status).toBe(200);
    const json = await res.json() as { html: string | null };
    expect(json.html).toContain("hi");
  });

  it("serves the (empty) changes list with no token", async () => {
    const res = await app().request(`/api/v1/public/repos/${NS}/${REPO}/changes`);
    expect(res.status).toBe(200);
    expect((await res.json() as { changes: unknown[] }).changes).toEqual([]);
  });

  it("does NOT shadow the og.svg route mounted by public.ts", async () => {
    const res = await app().request(`/api/v1/public/repos/${NS}/${REPO}/og.svg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OG");
  });
});

describe("public repo routes — PRIVATE repo is invisible to anonymous callers", () => {
  const app = () => makeApp(false);

  it("404s the repo metadata (no existence leak)", async () => {
    const res = await app().request(`/api/v1/public/repos/${NS}/${REPO}`);
    expect(res.status).toBe(404);
  });

  it("404s the tree", async () => {
    const res = await app().request(`/api/v1/public/repos/${NS}/${REPO}/tree/main`);
    expect(res.status).toBe(404);
  });

  it("404s a blob", async () => {
    const res = await app().request(`/api/v1/public/repos/${NS}/${REPO}/blob?ref=main&path=README.md`);
    expect(res.status).toBe(404);
  });

  it("404s the changes list", async () => {
    const res = await app().request(`/api/v1/public/repos/${NS}/${REPO}/changes`);
    expect(res.status).toBe(404);
  });
});
