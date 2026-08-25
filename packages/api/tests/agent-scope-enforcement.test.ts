import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import simpleGit from "simple-git";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, branches, changes, repositories, users } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { upsertQuota } from "../src/services/agent-scope.js";
import { processPush } from "../src/services/post-push.js";

// #205 — enforceScope decided the operator's per-agent caps on the agent's OWN
// trailers: `Scope:` for the path allowlist/denylist and `Risk:` for the
// ceiling. The git-derived changedPaths and the computed risk sat in the same
// function and were never passed, so writing `Scope: README.md` shipped any
// denied path and any risk. Same bug class #130 fixed for the secret gate.
// Driven through the REAL processPush over a real repo + Postgres because the
// defect is the wiring, not enforceScope's own logic.

const S = Date.now();

describe.skipIf(!hasTestDb)("agent scope caps are decided on git facts, not trailers (#205)", () => {
  let base: string;
  let git: GitService;
  let ns: string;
  let uid: string;
  let seq = 0;

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "clawhub-scope-"));
    git = new GitService(path.join(base, "repos"));
    const [u] = await db.insert(users).values({ email: `sc-${S}@t.co`, username: `scu${S}`, passwordHash: "x" }).returning();
    ns = u.username!;
    uid = u.id;
  });

  afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

  async function makeRepo(): Promise<{ repoId: string; repoName: string; agentId: string; workdir: string }> {
    const n = seq++;
    const repoName = `screpo${S}x${n}`;
    const [r] = await db.insert(repositories).values({ name: repoName, namespaceType: "user", namespaceId: uid, defaultBranch: "main" }).returning();
    const [a] = await db.insert(agents).values({
      name: `sc-agent-${S}-${n}`, tokenHash: "x", gitAuthorName: "sc-bot", gitAuthorEmail: "sc-bot@clawhub.test",
    }).returning();
    await git.initBare(ns, repoName);
    const workdir = path.join(base, `work${n}`);
    await mkdir(workdir, { recursive: true });
    const g = simpleGit(workdir);
    await g.init(["-b", "main"]);
    await g.addConfig("user.name", "t");
    await g.addConfig("user.email", "t@t");
    await writeFile(path.join(workdir, "README.md"), "# repo\n");
    await g.add(["-A"]);
    await g.commit("init");
    await g.raw(["push", "--force", git.pathOf(ns, repoName), "HEAD:refs/heads/main"]);
    await db.insert(branches).values({ repoId: r.id, name: "main", headCommit: (await g.revparse(["HEAD"])).trim() });
    return { repoId: r.id, repoName, agentId: a.id, workdir };
  }

  /** Commit the given files on a branch with the given trailers, push, run processPush. */
  function push(ctx: { repoId: string; repoName: string; agentId: string; workdir: string }, branch: string, files: Record<string, string>, trailers: string[]) {
    return (async () => {
      const g = simpleGit(ctx.workdir);
      await g.raw(["checkout", "-B", branch, "main"]);
      for (const [f, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(ctx.workdir, f)), { recursive: true });
        await writeFile(path.join(ctx.workdir, f), content);
      }
      await g.add(["-A"]);
      await g.commit([`Work on ${branch}`, "", ...trailers].join("\n"));
      const newSha = (await g.revparse(["HEAD"])).trim();
      await g.raw(["push", "--force", git.pathOf(ns, ctx.repoName), `HEAD:refs/heads/${branch}`]);
      await processPush({
        db, git,
        changeRefs: { set: async () => {} } as never,
        events: { publish: async () => {} } as never,
        namespace: ns, repoName: ctx.repoName, repoId: ctx.repoId, defaultBranch: "main",
        actor: { kind: "agent", agentId: ctx.agentId },
        pushedRefs: [{ ref: `refs/heads/${branch}`, oldSha: "0".repeat(40), newSha }],
      });
    })();
  }

  it("THE BUG: touching a denied path while declaring `Scope: README.md` is rejected", async () => {
    const ctx = await makeRepo();
    await upsertQuota(db, ctx.agentId, { pathDenylist: ["deploy/**", "scripts/**"] });
    await expect(push(ctx, "sneak", { "deploy/values.yaml": "image: evil\n", "README.md": "# updated\n" },
      ["Intent: Clarify the README", "Scope: README.md", "Risk: low"],
    )).rejects.toThrow(/path_denied/);
    // The gate fired before the Change row was written.
    expect(await db.select().from(changes).where(and(eq(changes.repoId, ctx.repoId), eq(changes.branch, "sneak")))).toHaveLength(0);
  });

  it("THE BUG: a narrower declared Scope no longer SATISFIES a configured allowlist", async () => {
    const ctx = await makeRepo();
    await upsertQuota(db, ctx.agentId, { pathAllowlist: ["docs/**", "README.md"] });
    await expect(push(ctx, "sneak-allow", { "src/core.ts": "// out of bounds\n", "README.md": "# updated\n" },
      ["Intent: Clarify the README", "Scope: README.md", "Risk: low"],
    )).rejects.toThrow(/path_not_allowed/);
  });

  it("THE BUG: the risk ceiling is checked against the COMPUTED risk, not the declared trailer", async () => {
    const ctx = await makeRepo();
    await upsertQuota(db, ctx.agentId, { riskCeiling: "low" });
    // Dockerfile.prod floors computed risk at medium (#188 taxonomy) — declaring
    // `Risk: low` used to sail under a low ceiling.
    await expect(push(ctx, "sneak-risk", { "Dockerfile.prod": "FROM scratch\n" },
      ["Intent: tweak the image", "Risk: low"],
    )).rejects.toThrow(/risk_ceiling/);
  });

  it("an honest agent declaring a BROADER Scope than it touched still passes", async () => {
    const ctx = await makeRepo();
    await upsertQuota(db, ctx.agentId, { pathAllowlist: ["docs/**", "README.md"] });
    await push(ctx, "honest", { "README.md": "# again\n" },
      ["Intent: docs", "Scope: README.md, docs/guide.md", "Risk: low"]);
    expect(await db.select().from(changes).where(and(eq(changes.repoId, ctx.repoId), eq(changes.branch, "honest")))).toHaveLength(1);
  });

  it("default (empty) quotas are unaffected", async () => {
    const ctx = await makeRepo();
    await push(ctx, "free", { "deploy/values.yaml": "image: ok\n" }, ["Intent: deploy tweak", "Risk: low"]);
    expect(await db.select().from(changes).where(and(eq(changes.repoId, ctx.repoId), eq(changes.branch, "free")))).toHaveLength(1);
  });
});
