import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agentMemories, agents, changes, orgMembers, organizations, repoCollaborators, repositories, standingAgents, users } from "../src/models/schema.js";
import { createRepoRoutes } from "../src/routes/repos.js";
import { createAttentionRoutes } from "../src/routes/attention.js";
import { createMemoryFleetRoutes, createStandingFleetRoutes } from "../src/routes/agent-aggregates.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signToken } from "../src/services/auth.js";
import type { GitService } from "../src/services/git.js";

process.env.JWT_SECRET ??= "test-secret-repo-visibility";

// Issue #187: `repo_collaborators.userId` — the HUMAN per-repo grant — is
// honoured by `repoAccessFor`, so an invited human can open the repo by direct
// URL. But every LIST surface hand-rolled its own visibility block and none of
// them queried that column on the human branch: the repo appeared in neither
// `GET /repos` nor `GET /attention`, and the dashboard home rendered its
// deliberate "nothing needs you" ALL-CLEAR — an inverted, silent failure with
// no error to catch. This is #132 generalized: that issue fixed the same class
// in search + the fork list and introduced `visibleRepoIds` for exactly this.
//
// Real DB, real routes: the fix is nothing but membership queries.
const S = Date.now();

// GET / on both routers is DB-only — neither touches git (git.stats runs only
// under ?stats=1) nor the event bus.
function app(): Hono {
  const a = new Hono();
  a.route("/api/v1/repos", createRepoRoutes(db, {} as GitService));
  a.route("/api/v1/attention", createAttentionRoutes(db));
  a.route("/api/v1/standing-agents", createStandingFleetRoutes(db));
  a.route("/api/v1/memory", createMemoryFleetRoutes(db));
  a.onError(errorHandler);
  return a;
}

function userToken(userId: string) { return signToken({ kind: "user", userId, email: `${userId}@t.co` }); }
function agentToken(agentId: string, name: string) { return signToken({ kind: "agent", agentId, name }); }

async function listRepos(token: string): Promise<string[]> {
  const res = await app().request("/api/v1/repos", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json() as { repos: Array<{ id: string }> }).repos.map(r => r.id);
}
async function attentionRepoIds(token: string): Promise<string[]> {
  const res = await app().request("/api/v1/attention", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json() as { items: Array<{ change: { repoId: string } }> }).items.map(i => i.change.repoId);
}

async function hubStandingRepoIds(token: string): Promise<string[]> {
  const res = await app().request("/api/v1/standing-agents", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json() as { standingAgents: Array<{ repoId: string | null }> }).standingAgents
    .map(s => s.repoId).filter((x): x is string => !!x);
}
async function hubMemoryRepoIds(token: string): Promise<string[]> {
  const res = await app().request("/api/v1/memory", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json() as { memories: Array<{ repoId: string | null }> }).memories
    .map(m => m.repoId).filter((x): x is string => !!x);
}

async function mkUser(tag: string) {
  const username = `v187-${tag}-${S}`;
  const [u] = await db.insert(users).values({ email: `${username}@t.co`, username, passwordHash: "x" }).returning();
  return { id: u.id, username };
}
async function mkAgent(tag: string, associatedUserId: string | null) {
  const name = `v187-${tag}-${S}`;
  const [a] = await db.insert(agents).values({
    name, tokenHash: "x", associatedUserId, gitAuthorName: name, gitAuthorEmail: `${name}@t.co`,
  }).returning();
  return a;
}
async function mkRepo(tag: string, ownerId: string, isPublic = false) {
  const [r] = await db.insert(repositories).values({
    name: `v187${tag}${S}`, namespaceType: "user", namespaceId: ownerId, defaultBranch: "main", isPublic,
  }).returning();
  return r;
}
async function mkOpenChange(repoId: string, intent: string) {
  const [ch] = await db.insert(changes).values({
    repoId, branch: `feat-${S}`, headCommit: "a".repeat(40), intent, risk: "high", status: "pending",
  }).returning();
  return ch;
}

describe.skipIf(!hasTestDb)("list surfaces honour the human collaborator grant (#187)", () => {
  let alice: { id: string; username: string };   // owner
  let bob: { id: string; username: string };     // invited human
  let carol: { id: string; username: string };   // no relationship at all
  let dave: { id: string; username: string };    // reaches a repo only through HIS agent
  let payments: typeof repositories.$inferSelect;      // private, Bob is a collaborator
  let vendor: typeof repositories.$inferSelect;        // private, Dave's agent is a collaborator
  let openSource: typeof repositories.$inferSelect;    // PUBLIC, nobody below is a member

  beforeAll(async () => {
    alice = await mkUser("alice");
    bob = await mkUser("bob");
    carol = await mkUser("carol");
    dave = await mkUser("dave");

    payments = await mkRepo("payments", alice.id);
    vendor = await mkRepo("vendor", alice.id);
    openSource = await mkRepo("oss", alice.id, true);

    // The shipped invite flow: POST /repos/:ns/:repo/collaborators/users writes
    // exactly this row (reviewer — the low-trust tier the grant exists for).
    await db.insert(repoCollaborators).values({ repoId: payments.id, userId: bob.id, role: "reviewer" });

    // The second half of the omission: a grant held by a human's OWN agent.
    const davesAgent = await mkAgent("daves-agent", dave.id);
    await db.insert(repoCollaborators).values({ repoId: vendor.id, agentId: davesAgent.id, role: "writer" });

    await mkOpenChange(payments.id, "raise the payout ceiling");
    await mkOpenChange(vendor.id, "swap the vendor SDK");
    await mkOpenChange(openSource.id, "tidy the readme");
  });

  it("shows an invited human the repo in GET /repos", async () => {
    expect(await listRepos(userToken(bob.id))).toContain(payments.id);
  });

  it("puts that repo's open Changes in the invited human's attention queue", async () => {
    // The bug's real shape: not an error, but an authoritative empty all-clear.
    expect(await attentionRepoIds(userToken(bob.id))).toContain(payments.id);
  });

  it("shows a human the repos their OWN agents are granted on", async () => {
    expect(await listRepos(userToken(dave.id))).toContain(vendor.id);
    expect(await attentionRepoIds(userToken(dave.id))).toContain(vendor.id);
  });

  it("does not widen: a human with no grant sees neither the repo nor its changes", async () => {
    const repos = await listRepos(userToken(carol.id));
    expect(repos).not.toContain(payments.id);
    expect(repos).not.toContain(vendor.id);
    const queue = await attentionRepoIds(userToken(carol.id));
    expect(queue).not.toContain(payments.id);
    expect(queue).not.toContain(vendor.id);
  });

  it("does not widen: an unrelated PUBLIC repo still stays out of both lists", async () => {
    // These surfaces are membership lists, not a directory of everything
    // readable — public repos have never appeared here and must not start.
    expect(await listRepos(userToken(bob.id))).not.toContain(openSource.id);
    expect(await attentionRepoIds(userToken(bob.id))).not.toContain(openSource.id);
  });

  it("keeps the owner's own repos (no regression)", async () => {
    const repos = await listRepos(userToken(alice.id));
    expect(repos).toEqual(expect.arrayContaining([payments.id, vendor.id, openSource.id]));
    expect(await attentionRepoIds(userToken(alice.id))).toEqual(expect.arrayContaining([payments.id, vendor.id]));
  });

  it("keeps agent callers on their collaborator grants + own namespace (no regression)", async () => {
    const reviewer = await mkAgent("reviewer", null);
    await db.insert(repoCollaborators).values({ repoId: payments.id, agentId: reviewer.id, role: "reviewer" });
    const tok = agentToken(reviewer.id, reviewer.name);
    expect(await listRepos(tok)).toContain(payments.id);
    expect(await attentionRepoIds(tok)).toContain(payments.id);
    expect(await listRepos(tok)).not.toContain(vendor.id);
  });

  it("keeps org membership working for both surfaces (no regression)", async () => {
    const [org] = await db.insert(organizations).values({ name: `v187org${S}`, ownerUserId: alice.id }).returning();
    const [orgRepo] = await db.insert(repositories).values({
      name: `v187orgrepo${S}`, namespaceType: "org", namespaceId: org.id, defaultBranch: "main", isPublic: false,
    }).returning();
    await mkOpenChange(orgRepo.id, "org repo change");
    await db.insert(orgMembers).values({ orgId: org.id, userId: carol.id, role: "member" });
    expect(await listRepos(userToken(carol.id))).toContain(orgRepo.id);
    expect(await attentionRepoIds(userToken(carol.id))).toContain(orgRepo.id);
  });
});

// The two things the #187 verify run caught, live, on the first attempt at this
// fix. `visibleRepos` is the batch form of `repoAccessFor`, which is STRICTLY
// wider than the hand-rolled blocks it replaced on two axes the issue never
// asked to move. Neither is caught by the suite above: its only agent caller is
// unsponsored, and it never touches the hub aggregates.
describe.skipIf(!hasTestDb)("routing lists through visibleRepos must not widen them (#187)", () => {
  let sponsor: { id: string; username: string };
  let sponsored: typeof agents.$inferSelect;   // sponsor's agent, ZERO collaborator grants
  let secret: typeof repositories.$inferSelect;  // sponsor's own private repo
  let orgRepo: typeof repositories.$inferSelect; // repo of an org the sponsor belongs to

  let owner: { id: string; username: string };
  let invited: { id: string; username: string };   // reviewer-tier HUMAN collaborator
  let viaAgent: { id: string; username: string };  // reaches the repo only through HIS agent's grant
  let ops: typeof repositories.$inferSelect;       // owner's private repo, with a deployment + memory on it

  beforeAll(async () => {
    sponsor = await mkUser("sponsor");
    sponsored = await mkAgent("sponsored", sponsor.id);
    secret = await mkRepo("secret", sponsor.id);
    await mkOpenChange(secret.id, "sponsor's own work");
    const [org] = await db.insert(organizations).values({ name: `v187w-org-${S}`, ownerUserId: sponsor.id }).returning();
    await db.insert(orgMembers).values({ orgId: org.id, userId: sponsor.id, role: "admin" });
    [orgRepo] = await db.insert(repositories).values({
      name: `v187worg${S}`, namespaceType: "org", namespaceId: org.id, defaultBranch: "main", isPublic: false,
    }).returning();
    await mkOpenChange(orgRepo.id, "org work");

    owner = await mkUser("hubowner");
    invited = await mkUser("hubinvited");
    viaAgent = await mkUser("hubviaagent");
    ops = await mkRepo("ops", owner.id);
    await db.insert(repoCollaborators).values({ repoId: ops.id, userId: invited.id, role: "reviewer" });
    const viaAgentsAgent = await mkAgent("hubviaagents-agent", viaAgent.id);
    await db.insert(repoCollaborators).values({ repoId: ops.id, agentId: viaAgentsAgent.id, role: "writer" });

    // The rows the hub aggregates render. `task` is plaintext deployment config;
    // the repo-scoped GET .../standing-agents 403s both humans below.
    const deployed = await mkAgent("hubdeployed", owner.id);
    await db.insert(standingAgents).values({
      repoId: ops.id, agentId: deployed.id, name: `v187dep${S}`, image: "clawhub-agent-harness:latest",
      task: "rotate the production database credentials", mode: "worker",
      tokenCiphertext: "sealed", tokenNonce: "nonce", createdByUserId: owner.id,
    });
    await db.insert(agentMemories).values({
      scope: "repo", scopeKey: `repo:${ops.id}`, repoId: ops.id, agentId: deployed.id,
      kind: "convention", title: `v187mem${S}`, body: "the prod deploy key lives in the ops vault",
    });
  });

  // Axis 1 — the REPO SET, for agent callers. repoAccessFor admits an agent to
  // its sponsoring human's namespaces and orgs with no collaborator row at all,
  // so an agent created via POST /agents under a user Bearer went from listing
  // nothing to listing its sponsor's whole world.
  it("an agent with no grants does not inherit its sponsor's repos in GET /repos", async () => {
    const tok = agentToken(sponsored.id, sponsored.name);
    const repos = await listRepos(tok);
    expect(repos).not.toContain(secret.id);
    expect(repos).not.toContain(orgRepo.id);
  });

  it("an agent with no grants does not inherit its sponsor's repos in GET /attention", async () => {
    const queue = await attentionRepoIds(agentToken(sponsored.id, sponsored.name));
    expect(queue).not.toContain(secret.id);
    expect(queue).not.toContain(orgRepo.id);
  });

  it("an explicit grant still reaches an agent that HAS a sponsor", async () => {
    // The narrowing is subtractive only — it must not cost a sponsored agent the
    // grants it actually holds.
    await db.insert(repoCollaborators).values({ repoId: ops.id, agentId: sponsored.id, role: "writer" });
    expect(await listRepos(agentToken(sponsored.id, sponsored.name))).toContain(ops.id);
  });

  // Axis 2 — the ACCESS LEVEL, on the cross-repo hub. `visibleRepos` is READ
  // membership and includes repo_collaborators; the repo-scoped routes for the
  // very same rows gate on namespace OWNERSHIP and honour no grant at all
  // (standing-agents.ts assertOperator, memory.ts assertHumanRepoAccess). A
  // cross-repo aggregate must not be a softer door than the repo-scoped route.
  it("the standing-agent hub does not hand a reviewer-tier collaborator another owner's deployment", async () => {
    expect(await hubStandingRepoIds(userToken(invited.id))).not.toContain(ops.id);
  });

  it("the standing-agent hub does not open to a human who reaches the repo only through his agent", async () => {
    expect(await hubStandingRepoIds(userToken(viaAgent.id))).not.toContain(ops.id);
  });

  it("the memory hub does not hand a reviewer-tier collaborator another owner's agent memory", async () => {
    expect(await hubMemoryRepoIds(userToken(invited.id))).not.toContain(ops.id);
    expect(await hubMemoryRepoIds(userToken(viaAgent.id))).not.toContain(ops.id);
  });

  it("the repo's own governor still sees both on the hub (no regression)", async () => {
    expect(await hubStandingRepoIds(userToken(owner.id))).toContain(ops.id);
    expect(await hubMemoryRepoIds(userToken(owner.id))).toContain(ops.id);
  });

  it("the invited human still sees the repo itself — the whole point of #187", async () => {
    // The narrowing above is scoped to the hub aggregates; the read-level lists
    // must keep the fix.
    expect(await listRepos(userToken(invited.id))).toContain(ops.id);
  });
});
