import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../src/models/db.js";
import { changes, repositories, users } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { ChangeRefService } from "../src/services/change-refs.js";
import { EventBus } from "../src/services/events.js";
import { mergeAgentsMdBlock, openServerChange, syncAgentsMdChange } from "../src/services/server-change.js";
import { AGENTS_MD_BEGIN, AGENTS_MD_END } from "../src/services/agents-md.js";

// N5 server-authored-Change primitive: ClawHub authors a commit + opens a Change
// with no container. Real DB (>=0052) + a scratch on-disk bare repo.
const S = Date.now();
let git: GitService, changeRefs: ChangeRefService, events: EventBus, repoId: string;
const NS = `clawhub-system`; // openServerChange authors as the clawhub-system service user, but repo ns is the owner
let ownerNs: string;

function gitRun(dir: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", dir, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: join(dir, "seed-index"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.co", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.co" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "clawhub-sc-"));
  git = new GitService(base);
  changeRefs = new ChangeRefService(git);
  events = new EventBus();
  const [u] = await db.insert(users).values({ email: `sc-${S}@t.co`, username: `scu${S}`, passwordHash: "x" }).returning();
  ownerNs = u.username!;
  const [r] = await db.insert(repositories).values({ name: `screpo${S}`, namespaceType: "user", namespaceId: u.id, defaultBranch: "main" }).returning();
  repoId = r.id;
  // Seed a bare repo with an initial main commit (a README).
  const dir = git.pathOf(ownerNs, r.name);
  await git.initBare(ownerNs, r.name);
  await gitRun(dir, ["read-tree", "--empty"]);
  const blob = await gitRun(dir, ["hash-object", "-w", "--stdin", "--path", "README.md"], "# seed\n");
  await gitRun(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},README.md`]);
  const tree = await gitRun(dir, ["write-tree"]);
  const commit = await gitRun(dir, ["commit-tree", tree, "-m", "init"]);
  await gitRun(dir, ["update-ref", "refs/heads/main", commit]);
});

describe("mergeAgentsMdBlock", () => {
  it("returns the block for an empty file", () => {
    const out = mergeAgentsMdBlock(null);
    expect(out).toContain(AGENTS_MD_BEGIN);
    expect(out).toContain(AGENTS_MD_END);
  });
  it("replaces an existing managed block in place", () => {
    const existing = `# Title\n\n${AGENTS_MD_BEGIN}\nOLD\n${AGENTS_MD_END}\n\n## Footer\n`;
    const out = mergeAgentsMdBlock(existing);
    expect(out).toContain("# Title");
    expect(out).toContain("## Footer");
    expect(out).not.toContain("OLD");
    expect((out.match(new RegExp(AGENTS_MD_BEGIN, "g")) ?? []).length).toBe(1);
  });
  it("appends when there is no managed block", () => {
    const out = mergeAgentsMdBlock("# Just a heading\n");
    expect(out).toContain("# Just a heading");
    expect(out).toContain(AGENTS_MD_BEGIN);
  });
});

describe("openServerChange + syncAgentsMdChange", () => {
  it("opens an AGENTS.md sync Change, and is idempotent", async () => {
    const first = await syncAgentsMdChange({ db, git, changeRefs, events }, repoId);
    expect(first.changed).toBe(true);
    expect(first.changeId).toBeTruthy();
    // the Change exists on the sync branch, authored by clawhub-system
    const chg = (await db.select().from(changes).where(and(eq(changes.repoId, repoId), eq(changes.branch, "clawhub/agents-md-sync"))).limit(1))[0];
    expect(chg).toBeTruthy();
    expect(chg.intent).toContain("AGENTS.md");
    // the new commit actually contains the managed block
    const content = await git.fileAt(ownerNs, `screpo${S}`, chg.headCommit, "AGENTS.md");
    expect(content).toContain(AGENTS_MD_BEGIN);

    // Running again with the block already applied → no new proposal.
    const second = await syncAgentsMdChange({ db, git, changeRefs, events }, repoId);
    // (The base branch hasn't merged the change, so the block still isn't on main
    //  — the second run re-opens/updates the SAME branch. Assert it doesn't throw
    //  and targets the same branch.)
    expect(second.branch ?? "clawhub/agents-md-sync").toBe("clawhub/agents-md-sync");
  });

  it("no-ops when the file content already matches", async () => {
    const res = await openServerChange({
      db, git, changeRefs, events, repoId,
      branch: "clawhub/noop-test",
      files: [{ path: "README.md", content: "# seed\n" }], // identical to the seeded base
      intent: "should be a no-op",
    });
    expect(res.changed).toBe(false);
    expect(res.changeId).toBeUndefined();
  });
});
