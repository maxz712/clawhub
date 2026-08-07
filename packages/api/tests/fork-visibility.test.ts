import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { changes, repoCollaborators, repositories, users } from "../src/models/schema.js";
import { createForkRoutes } from "../src/routes/forks.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signToken } from "../src/services/auth.js";
import type { EventBus } from "../src/services/events.js";
import type { GitService } from "../src/services/git.js";

process.env.JWT_SECRET ??= "test-secret-fork-visibility";

// Issue #132: `GET /:ns/:repo/forks` authorized the PARENT and then returned a
// bare `select()` over every child row. A fork inherits its parent's visibility
// at creation but is free to diverge — so anyone who could read a public parent
// got the full `repositories` row of every PRIVATE fork, `mergePolicy`
// (trustedAgents / verifiedAutonomy / auto-merge) included. Reading the parent
// is not authorization over the children.
//
// Real DB: the fix is `visibleRepoIds`, which is nothing but membership queries.
const S = Date.now();

// The fork routes' GET handlers never touch git or the event bus.
function app(): Hono {
  const a = new Hono();
  a.route("/api/v1/repos", createForkRoutes(db, {} as GitService, {} as EventBus));
  a.onError(errorHandler);
  return a;
}

type ForkRow = { id: string; name: string; isPublic: boolean; namespaceName: string | null };
async function listForks(ns: string, repo: string, userId: string): Promise<ForkRow[]> {
  const token = signToken({ kind: "user", userId, email: `${userId}@t.co` });
  const res = await app().request(`/api/v1/repos/${ns}/${repo}/forks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json() as { forks: ForkRow[] }).forks;
}

async function mkUser(tag: string) {
  const username = `f132-${tag}-${S}`;
  const [u] = await db.insert(users).values({ email: `${username}@t.co`, username, passwordHash: "x" }).returning();
  return { id: u.id, username };
}
async function mkRepo(tag: string, ownerId: string, isPublic: boolean, forkOf?: string) {
  const [r] = await db.insert(repositories).values({
    name: `f132${tag}${S}`, namespaceType: "user", namespaceId: ownerId, defaultBranch: "main", isPublic,
    forkOfRepoId: forkOf ?? null,
    // A distinctive governance posture, so a leak of it is unmistakable.
    mergePolicy: { trustedAgents: ["super-secret-trusted-agent"], autoMergeOnVerified: true },
  }).returning();
  return r;
}

describe.skipIf(!hasTestDb)("GET /:ns/:repo/forks never lists a fork the caller cannot reach (#132)", () => {
  let owner: { id: string; username: string };
  let alice: { id: string; username: string };
  let mallory: { id: string; username: string };
  let bob: { id: string; username: string };
  let carol: { id: string; username: string };
  let publicParent: typeof repositories.$inferSelect;
  let privateParent: typeof repositories.$inferSelect;
  let publicFork: typeof repositories.$inferSelect;
  let privateFork: typeof repositories.$inferSelect;
  let grantedFork: typeof repositories.$inferSelect;
  let privateForkOfPrivate: typeof repositories.$inferSelect;

  beforeAll(async () => {
    owner = await mkUser("owner");
    alice = await mkUser("alice");
    mallory = await mkUser("mallory");
    bob = await mkUser("bob");
    carol = await mkUser("carol");

    publicParent = await mkRepo("parentpub", owner.id, true);
    privateParent = await mkRepo("parentpriv", owner.id, false);

    // Forks of the PUBLIC parent: one left public, one Alice made private, one
    // private but with an explicit HUMAN collaborator grant to Carol.
    publicFork = await mkRepo("forkpub", alice.id, true, publicParent.id);
    privateFork = await mkRepo("forkpriv", alice.id, false, publicParent.id);
    grantedFork = await mkRepo("forkgrant", alice.id, false, publicParent.id);
    await db.insert(repoCollaborators).values({ repoId: grantedFork.id, userId: carol.id, role: "writer" });

    // Private parent shared with Alice and Bob; Alice forks it. Both can read
    // the PARENT — neither has a grant on the OTHER's fork.
    await db.insert(repoCollaborators).values({ repoId: privateParent.id, userId: bob.id, role: "writer" });
    await db.insert(repoCollaborators).values({ repoId: privateParent.id, userId: alice.id, role: "writer" });
    privateForkOfPrivate = await mkRepo("forkofpriv", alice.id, false, privateParent.id);
  });

  it("(a) an unrelated authenticated user sees only the PUBLIC fork of a public parent", async () => {
    const names = (await listForks(owner.username, publicParent.name, mallory.id)).map(f => f.name);
    expect(names).toEqual([publicFork.name]);
    expect(names).not.toContain(privateFork.name);
    expect(names).not.toContain(grantedFork.name);
  });

  it("(b) a co-collaborator of a PRIVATE parent does not see a fork he has no grant on", async () => {
    // Bob can read the parent — that is exactly the access the old code mistook
    // for access to the children.
    expect(await listForks(owner.username, privateParent.name, bob.id)).toEqual([]);
    // ...and the fork's owner still sees it.
    expect((await listForks(owner.username, privateParent.name, alice.id)).map(f => f.name))
      .toEqual([privateForkOfPrivate.name]);
  });

  it("(c) the fork OWNER still sees their own private forks", async () => {
    const names = (await listForks(owner.username, publicParent.name, alice.id)).map(f => f.name).sort();
    expect(names).toEqual([publicFork.name, grantedFork.name, privateFork.name].sort());
  });

  it("(d) a human holding a repoCollaborators.userId grant on a private fork still sees it", async () => {
    // The regression this guards against is over-correcting: a batch visibility
    // helper that only reads AGENT grants would hide a repo from the very human
    // explicitly granted access to it.
    const names = (await listForks(owner.username, publicParent.name, carol.id)).map(f => f.name).sort();
    expect(names).toEqual([publicFork.name, grantedFork.name].sort());
    expect(names).not.toContain(privateFork.name);
  });

  it("(e) public forks are listed for everyone, with a resolved namespace name", async () => {
    for (const who of [mallory, alice, carol, owner]) {
      const pub = (await listForks(owner.username, publicParent.name, who.id)).find(f => f.name === publicFork.name);
      expect(pub, `visible to ${who.username}`).toBeDefined();
      // The row carries only a (kind, id) tuple; without resolution the UI
      // rendered "?/name" and linked into the PARENT's namespace.
      expect(pub!.namespaceName).toBe(alice.username);
    }
  });

  it("(f) the response projects columns — no mergePolicy, no platform-feature posture", async () => {
    const res = await app().request(`/api/v1/repos/${owner.username}/${publicParent.name}/forks`, {
      headers: { authorization: `Bearer ${signToken({ kind: "user", userId: alice.id, email: "a@t.co" })}` },
    });
    const raw = await res.text();
    expect(raw).not.toContain("mergePolicy");
    expect(raw).not.toContain("super-secret-trusted-agent");
    expect(raw).not.toContain("nativeReviewerEnabled");
    expect(raw).not.toContain("platformVerifyEnabled");
    // The fields the fork directory actually needs are still there.
    const body = JSON.parse(raw) as { forks: ForkRow[] };
    expect(body.forks.length).toBeGreaterThan(0);
    for (const f of body.forks) expect(Object.keys(f).sort()).toContain("isPublic");
  });
});

describe.skipIf(!hasTestDb)("GET /:ns/:repo/changes/:id/proposal binds the change to the repo (#132)", () => {
  it("404s for a change id belonging to a DIFFERENT repo", async () => {
    const victim = await mkUser("victimp");
    const attacker = await mkUser("attackerp");
    const victimRepo = await mkRepo("victimrepo", victim.id, false);
    const attackerRepo = await mkRepo("attackerrepo", attacker.id, true);
    const [victimChange] = await db.insert(changes).values({
      repoId: victimRepo.id, branch: `b${S}`, headCommit: "a".repeat(40), intent: "secret work",
    }).returning();

    const token = signToken({ kind: "user", userId: attacker.id, email: "x@t.co" });
    const path = `/api/v1/repos/${attacker.username}/${attackerRepo.name}/changes/${victimChange.id}/proposal`;
    const res = await app().request(path, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);

    // A change that DOES belong to the resolved repo still resolves (200, null
    // proposal) — the binding must not break the normal read.
    const [ownChange] = await db.insert(changes).values({
      repoId: attackerRepo.id, branch: `b2${S}`, headCommit: "b".repeat(40), intent: "own work",
    }).returning();
    const ok = await app().request(
      `/api/v1/repos/${attacker.username}/${attackerRepo.name}/changes/${ownChange.id}/proposal`,
      { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { proposal: unknown }).proposal).toBeNull();
  });
});
