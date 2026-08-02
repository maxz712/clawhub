import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, unlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import * as schema from "../src/models/schema.js";
import { codeGraphEdges, codeGraphNodes, repositories } from "../src/models/schema.js";
import { buildCodeGraphAtCommit } from "../src/services/code-graph.js";
import { GitService } from "../src/services/git.js";

// DB-backed integration tests for the Graphify INCREMENTAL update path (#113).
// The incremental branch used to prune edges only by srcPath, so deleting or
// renaming an imported file left every edge POINTING AT it dangling forever
// (edges are only re-authored when their source file is reprocessed, and a full
// rebuild only runs when the graph is empty — no self-heal). These tests drive
// a real bare repo through delete/modify/rename commits and assert dstPath
// pruning against a real Postgres. Skipped unless CLAWHUB_TEST_DATABASE_URL is
// set, like memory-db.test.ts:
//
//   CLAWHUB_TEST_DATABASE_URL=postgresql://me@localhost:5432/clawhub_test npx vitest run tests/code-graph-incremental.test.ts

const TEST_URL = process.env.CLAWHUB_TEST_DATABASE_URL;

const NS = "graph-test-ns";
const REPO = "graph-incremental-repo";

describe.skipIf(!TEST_URL)("Graphify incremental dstPath pruning", () => {
  const client = TEST_URL ? postgres(TEST_URL, { max: 2 }) : null!;
  const db = TEST_URL ? drizzle(client, { schema }) : null!;
  let repoId: string;
  let base: string;
  let git: GitService;
  let work: string;
  let g: SimpleGit;

  const commit = async (msg: string): Promise<string> => {
    await g.add(["-A"]);
    await g.commit(msg);
    await g.push([git.pathOf(NS, REPO), "main", "--force"]);
    return (await g.revparse(["HEAD"])).trim();
  };

  const edgesTo = (dst: string) =>
    db.select().from(codeGraphEdges).where(and(eq(codeGraphEdges.repoId, repoId), eq(codeGraphEdges.dstPath, dst)));

  beforeAll(async () => {
    const [repo] = await db.insert(repositories).values({
      name: `graph-inc-test-${Date.now()}`, namespaceType: "user", namespaceId: randomUUID(),
    }).returning();
    repoId = repo.id;

    base = await mkdtemp(path.join(tmpdir(), "clawhub-graph-inc-"));
    git = new GitService(path.join(base, "repos"));
    await git.initBare(NS, REPO);

    work = path.join(base, "work");
    await mkdir(path.join(work, "src"), { recursive: true });
    g = simpleGit(work);
    await g.init(["-b", "main"]);
    await g.addConfig("user.name", "test");
    await g.addConfig("user.email", "test@test");
  });

  afterAll(async () => {
    if (repoId) await db.delete(repositories).where(eq(repositories.id, repoId)); // cascades nodes+edges
    await client?.end();
    if (base) await rm(base, { recursive: true, force: true });
  });

  let head: string;

  it("full build indexes edges a→b, a→c, a→config.json", async () => {
    await writeFile(path.join(work, "src/a.ts"), [
      'import { B } from "./b.js";',
      'import { C } from "./c.js";',
      'import cfg from "./config.json";',
      "export const A = 1;",
    ].join("\n"));
    await writeFile(path.join(work, "src/b.ts"), "export const B = 1;\n");
    await writeFile(path.join(work, "src/c.ts"), "export const C = 1;\n");
    await writeFile(path.join(work, "src/config.json"), "{}\n");
    head = await commit("seed");

    const r = await buildCodeGraphAtCommit(db, git, NS, REPO, repoId, head);
    expect(r.incremental).toBe(false);
    expect((await edgesTo("src/b.ts")).length).toBe(1);
    expect((await edgesTo("src/c.ts")).length).toBe(1);
    expect((await edgesTo("src/config.json")).length).toBe(1);
  });

  it("incremental delete of an imported file prunes edges pointing AT it, keeps edges to a merely-modified file", async () => {
    const prev = head;
    await unlink(path.join(work, "src/b.ts"));
    await writeFile(path.join(work, "src/c.ts"), "export const C = 2; // touched\n");
    head = await commit("delete b, touch c");

    const r = await buildCodeGraphAtCommit(db, git, NS, REPO, repoId, head, { sinceCommit: prev });
    expect(r.incremental).toBe(true);

    // Deleted target: no dangling dstPath edges, node rows gone too.
    expect(await edgesTo("src/b.ts")).toEqual([]);
    const bNodes = await db.select().from(codeGraphNodes)
      .where(and(eq(codeGraphNodes.repoId, repoId), eq(codeGraphNodes.path, "src/b.ts")));
    expect(bNodes).toEqual([]);

    // Content-changed-but-present target must RETAIN its incoming edge (no over-delete).
    expect((await edgesTo("src/c.ts")).length).toBe(1);
  });

  it("incremental delete of a NON-graphable imported file (json) still prunes its dangling edges", async () => {
    const prev = head;
    await unlink(path.join(work, "src/config.json"));
    head = await commit("delete config.json only");

    // Only non-graphable paths changed — the prune must run even though there
    // is nothing to (re)index.
    const r = await buildCodeGraphAtCommit(db, git, NS, REPO, repoId, head, { sinceCommit: prev });
    expect(r.incremental).toBe(true);
    expect(r.files).toBe(0);
    expect(await edgesTo("src/config.json")).toEqual([]);
  });

  it("incremental rename leaves no dangling edges to the old path", async () => {
    const prev = head;
    await rename(path.join(work, "src/c.ts"), path.join(work, "src/d.ts"));
    head = await commit("rename c → d");

    await buildCodeGraphAtCommit(db, git, NS, REPO, repoId, head, { sinceCommit: prev });
    // Old path pruned (edges AND symbol nodes — rename must decompose into
    // delete+add despite git's rename detection); the a→d edge may legitimately
    // be absent until src/a.ts is next reprocessed (edges are authored from the
    // source side).
    expect(await edgesTo("src/c.ts")).toEqual([]);
    const cNodes = await db.select().from(codeGraphNodes)
      .where(and(eq(codeGraphNodes.repoId, repoId), eq(codeGraphNodes.path, "src/c.ts")));
    expect(cNodes).toEqual([]);
    const dNodes = await db.select().from(codeGraphNodes)
      .where(and(eq(codeGraphNodes.repoId, repoId), eq(codeGraphNodes.path, "src/d.ts")));
    expect(dNodes.length).toBeGreaterThan(0);
  });
});
