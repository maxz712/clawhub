import { describe, it, expect, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, repoCollaborators, repositories, users } from "../src/models/schema.js";
import { signToken } from "../src/services/auth.js";
import type { ChangeRefService } from "../src/services/change-refs.js";
import type { EventBus } from "../src/services/events.js";
import type { GitService } from "../src/services/git.js";
import type { PushQueue } from "../src/services/push-queue.js";
import { ShardMap } from "../src/services/shard-map.js";
import { GitClientPool } from "../src/services/git-client.js";

process.env.JWT_SECRET ??= "test-secret-git-fetch-authz";

// Issue #146 — git-upload-pack (clone / ls-remote / fetch) was the ONE
// repo-scoped read surface that never authorized the caller against the repo.
// It asked "is the caller anonymous?" and stopped there, so any token from a
// free self-serve signup cloned every PRIVATE repo on the instance with full
// history (gh-mirror shadow repos of third-party GitHub PRs included), while
// reading a single file of the same repo over REST 404s.
//
// The fix routes the fetch branch through repo-access.ts like LFS and OCI
// already do. These tests drive the REAL git-http route against a real DB —
// authorization is nothing but membership queries — with the git CGI proxy
// mocked out, so the assertions are purely about who is admitted.

const proxyCalls: string[] = [];
vi.mock("../src/services/git-backend.js", () => ({
  // A distinctive body: reaching it at all means authorization passed and the
  // repo's objects were about to be served.
  proxyToGitBackend: async (_c: unknown, _git: unknown, ns: string, repo: string, suffix: string) => {
    proxyCalls.push(`${ns}/${repo}:${suffix}`);
    return new Response("PACK-SERVED", { status: 200 });
  },
}));

const { createGitHttpRoutes } = await import("../src/routes/git-http.js");

const S = Date.now();

function app(): Hono {
  const a = new Hono();
  a.route("/", createGitHttpRoutes({
    db,
    git: {} as GitService,
    changeRefs: {} as ChangeRefService,
    events: {} as EventBus,
    queue: { onFallback: () => {}, enqueue: async () => {} } as unknown as PushQueue,
    shardMap: new ShardMap(db),
    gitClients: new GitClientPool(),
  }));
  return a;
}

function basic(username: string, token: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}` };
}

/** GET /:ns/:repo.git/info/refs?service=git-upload-pack — the ref advertisement. */
async function advertiseRefs(ns: string, repo: string, headers: Record<string, string>) {
  proxyCalls.length = 0;
  const res = await app().request(`/${ns}/${repo}.git/info/refs?service=git-upload-pack`, { headers });
  return { status: res.status, body: await res.text(), served: proxyCalls.length > 0, res };
}

/** POST /:ns/:repo.git/git-upload-pack — the second fetch entry point. */
async function uploadPack(ns: string, repo: string, headers: Record<string, string>) {
  proxyCalls.length = 0;
  const res = await app().request(`/${ns}/${repo}.git/git-upload-pack`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-git-upload-pack-request" },
    body: "0000",
  });
  return { status: res.status, body: await res.text(), served: proxyCalls.length > 0 };
}

describe.skipIf(!hasTestDb)("git fetch authorization (#146)", () => {
  let ownerName = "";
  let privateName = "";
  let publicName = "";
  let ownerToken = "";
  let strangerToken = "";
  let strangerAgentToken = "";
  let collabAgentToken = "";
  let grantedHumanToken = "";

  beforeAll(async () => {
    const mkUser = async (tag: string) => {
      const username = `g146-${tag}-${S}`;
      const [u] = await db.insert(users).values({
        email: `${username}@t.local`, username, passwordHash: "x",
      }).returning();
      return { id: u.id, username };
    };
    const mkAgent = async (tag: string) => {
      const [a] = await db.insert(agents).values({
        name: `g146-${tag}-${S}`, tokenHash: "x",
        gitAuthorName: tag, gitAuthorEmail: `${tag}@t.local`,
      }).returning();
      return a;
    };
    const mkRepo = async (tag: string, ownerId: string, isPublic: boolean) => {
      const [r] = await db.insert(repositories).values({
        name: `g146${tag}${S}`, namespaceType: "user", namespaceId: ownerId,
        defaultBranch: "main", isPublic,
      }).returning();
      return r;
    };

    const owner = await mkUser("owner");
    const stranger = await mkUser("stranger");
    const granted = await mkUser("granted");
    ownerName = owner.username;

    const priv = await mkRepo("priv", owner.id, false);
    const pub = await mkRepo("pub", owner.id, true);
    privateName = priv.name;
    publicName = pub.name;

    const strangerAgent = await mkAgent("strangeragent");
    const collabAgent = await mkAgent("collabagent");
    await db.insert(repoCollaborators).values({ repoId: priv.id, agentId: collabAgent.id, role: "writer" });
    // A human granted directly on the repo — the `reviewer` tier, i.e. the
    // WEAKEST grant that still carries read. It must still be able to clone.
    await db.insert(repoCollaborators).values({ repoId: priv.id, userId: granted.id, role: "reviewer" });

    ownerToken = signToken({ kind: "user", userId: owner.id, email: `${owner.username}@t.local` });
    strangerToken = signToken({ kind: "user", userId: stranger.id, email: `${stranger.username}@t.local` });
    grantedHumanToken = signToken({ kind: "user", userId: granted.id, email: `${granted.username}@t.local` });
    strangerAgentToken = signToken({ kind: "agent", agentId: strangerAgent.id, name: strangerAgent.name });
    collabAgentToken = signToken({ kind: "agent", agentId: collabAgent.id, name: collabAgent.name });
  });

  // ── Denials ──────────────────────────────────────────────────────────────
  // These are the cases that PASSED (200 + full packfile) before the fix.

  it("404s a private-repo ref advertisement for an authenticated non-member user", async () => {
    const r = await advertiseRefs(ownerName, privateName, basic("stranger", strangerToken));
    expect(r.status).toBe(404);
    expect(r.served).toBe(false);
    // 404, not 403 — the repo's existence must not leak.
    expect(r.body).not.toContain("PACK-SERVED");
  });

  it("404s a private-repo ref advertisement for an authenticated non-member agent", async () => {
    const r = await advertiseRefs(ownerName, privateName, basic("agent-token", strangerAgentToken));
    expect(r.status).toBe(404);
    expect(r.served).toBe(false);
  });

  it("404s the POST git-upload-pack entry point too, not just info/refs", async () => {
    const r = await uploadPack(ownerName, privateName, basic("stranger", strangerToken));
    expect(r.status).toBe(404);
    expect(r.served).toBe(false);
  });

  // ── Admissions ───────────────────────────────────────────────────────────
  // Access is decided by repoAccessFor, not re-implemented locally, so every
  // membership path it honours must still clone.

  it("serves the owner's own private repo", async () => {
    const r = await advertiseRefs(ownerName, privateName, basic(ownerName, ownerToken));
    expect(r.status).toBe(200);
    expect(r.served).toBe(true);
  });

  it("serves a private repo to a collaborator agent", async () => {
    const r = await advertiseRefs(ownerName, privateName, basic("agent-token", collabAgentToken));
    expect(r.status).toBe(200);
    expect(r.served).toBe(true);
  });

  it("serves a private repo to a human with a direct reviewer-tier grant", async () => {
    const r = await advertiseRefs(ownerName, privateName, basic("granted", grantedHumanToken));
    expect(r.status).toBe(200);
    expect(r.served).toBe(true);
  });

  it("serves both fetch entry points to a legitimate reader", async () => {
    const r = await uploadPack(ownerName, privateName, basic(ownerName, ownerToken));
    expect(r.status).toBe(200);
    expect(r.served).toBe(true);
  });

  // ── Anonymous + public: no regression ────────────────────────────────────

  it("challenges an ANONYMOUS private-repo fetch with 401 + WWW-Authenticate", async () => {
    // Git probes unauthenticated first; a blanket 404 here would break
    // `git clone` of a private repo the caller legitimately owns.
    const r = await advertiseRefs(ownerName, privateName, {});
    expect(r.status).toBe(401);
    expect(r.res.headers.get("www-authenticate")).toContain("Basic");
    expect(r.served).toBe(false);
  });

  it("still serves a PUBLIC repo anonymously", async () => {
    const r = await advertiseRefs(ownerName, publicName, {});
    expect(r.status).toBe(200);
    expect(r.served).toBe(true);
  });

  it("still serves a PUBLIC repo to an authenticated non-member", async () => {
    const r = await advertiseRefs(ownerName, publicName, basic("stranger", strangerToken));
    expect(r.status).toBe(200);
    expect(r.served).toBe(true);
  });

  it("404s a repo that does not exist, for a member and a stranger alike", async () => {
    for (const h of [basic(ownerName, ownerToken), basic("stranger", strangerToken)]) {
      const r = await advertiseRefs(ownerName, `g146nope${S}`, h);
      expect(r.status).toBe(404);
      expect(r.served).toBe(false);
    }
  });
});
