import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, organizations, repositories, users } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { isReservedHandle, isPlatformNamespace, RESERVED_HANDLES, assertHandleAvailable, deriveUniqueUsername } from "../src/services/namespace.js";
import { ensureServiceUserForAgent, serviceUserEmail } from "../src/services/auto-repo.js";
import { ensureGhMirrorUser, MIRROR_USER_EMAIL } from "../src/services/github-mirror.js";
import { ensureSystemUser, SYSTEM_USER_EMAIL } from "../src/services/server-change.js";
import { forkRepo } from "../src/services/forks.js";
import { repoAccessFor, visibleRepoIds } from "../src/services/repo-access.js";
import { createAgentRoutes } from "../src/routes/agents.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signToken, hashToken, randomToken } from "../src/services/auth.js";
import type { EventBus } from "../src/services/events.js";

process.env.JWT_SECRET ??= "test-secret-service-handle";
// routes/agents.ts POST is the public self-register path; without this it 401s
// before it ever reaches the name checks under test.
process.env.CLAWHUB_ALLOW_UNCLAIMED_AGENT_REGISTER = "1";

// Issue #139: ClawHub's authorization model is namespaces all the way down —
// `repo-access.ts` decides what a caller may do to a repo largely by asking
// whose namespace the repo lives in. Two PLATFORM-owned namespaces (`gh-mirror`,
// which owns every private GitHub-App shadow repo, and `clawhub-system`, which
// authors server Changes) are `users` rows of `kind: 'service'` whose ONLY
// access control is the literal username string.
//
// Nothing reserved those strings, and `ensureServiceUserForAgent` ADOPTED any
// pre-existing service user with a matching name — so one signup + one
// agent-create + one fork of any public repo made the attacker's agent a WRITER
// on every mirrored private PR on the instance.
//
// Two independent layers, tested separately, because either alone is a
// single point of failure:
//   1. create-time — the handle namespace is shared across users/orgs/agents,
//      and platform handles are reserved outright.
//   2. adopt-time  — a pre-existing service user is claimed only when it is
//      PROVABLY this agent's own (`svc-<agent id>@clawhub.invalid`), so a row
//      that got in some other way still can't take a namespace over.
const S = Date.now();

describe("reserved platform handles (#139, layer 1)", () => {
  it("reserves the namespaces ClawHub's own service accounts live in", () => {
    // These four are the load-bearing entries — the rest of the set is
    // future-proofing. gh-mirror + clawhub-system are `users` rows; the two
    // native-* names are ClawHub-owned system AGENTS.
    for (const h of ["gh-mirror", "clawhub-system", "clawhub-native-reviewer", "clawhub-native-verifier"]) {
      expect(RESERVED_HANDLES.has(h), `expected reserved: ${h}`).toBe(true);
      expect(isReservedHandle(h)).toBe(true);
    }
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    // A handle is compared against `users.username` / `agents.name` elsewhere;
    // a reserved-word check that only catches the exact lowercase spelling is
    // not a check. (`agents.name` accepts mixed case — the create regex is /i.)
    for (const spelling of ["GH-MIRROR", "Gh-Mirror", " gh-mirror ", "CLAWHUB-SYSTEM"]) {
      expect(isReservedHandle(spelling), `expected reserved: ${JSON.stringify(spelling)}`).toBe(true);
    }
  });

  it("scopes the ensure-time refusal to the four REAL platform namespaces", () => {
    // isPlatformNamespace is deliberately narrower than isReservedHandle: the
    // reserved list is a create-time courtesy that also fences off future
    // platform words, but ensureServiceUserForAgent runs against rows that
    // ALREADY EXIST, so a legacy agent named `admin` must keep working.
    for (const h of ["gh-mirror", "clawhub-system", "clawhub-native-reviewer", "clawhub-native-verifier"]) {
      expect(isPlatformNamespace(h)).toBe(true);
    }
    for (const h of ["admin", "www", "api", "clawhub", "support"]) {
      expect(isReservedHandle(h), `${h} should be reserved at create`).toBe(true);
      expect(isPlatformNamespace(h), `${h} must NOT block an existing agent`).toBe(false);
    }
  });

  it("leaves ordinary handles alone", () => {
    for (const ok of ["gh-mirrors", "my-gh-mirror", "clawhub-systems", "alice", "verify-bot", ""]) {
      expect(isReservedHandle(ok), `expected available: ${JSON.stringify(ok)}`).toBe(false);
    }
    expect(isReservedHandle(undefined)).toBe(false);
    expect(isReservedHandle(42)).toBe(false);
  });
});

describe.skipIf(!hasTestDb)("agent create can't squat a platform or existing handle (#139, layer 1)", () => {
  let base: string;
  let git: GitService;

  const app = () => {
    const a = new Hono();
    a.route("/api/v1/agents", createAgentRoutes(db));
    a.onError(errorHandler);
    return a;
  };
  const register = (name: string) => app().request("/api/v1/agents", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });

  const RESERVED_UNDER_TEST = ["gh-mirror", "clawhub-system", "GH-MIRROR"];

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "clawhub-139a-"));
    git = new GitService(base);
    // The "creates no row" assertions below read a GLOBAL name, so start from a
    // known-clean state — a leftover row (e.g. from running this suite against
    // the pre-fix code) would otherwise fail the test for the wrong reason.
    for (const n of RESERVED_UNDER_TEST) await db.delete(agents).where(eq(agents.name, n));
  });
  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
    for (const n of RESERVED_UNDER_TEST) await db.delete(agents).where(eq(agents.name, n));
  });

  it("400s POST /api/v1/agents for every reserved platform handle", async () => {
    for (const name of ["gh-mirror", "clawhub-system", "GH-MIRROR"]) {
      const res = await register(name);
      expect(res.status, `expected 400 for ${name}`).toBe(400);
      expect((await res.json() as { message?: string }).message).toMatch(/reserved/i);
      expect(await db.select().from(agents).where(eq(agents.name, name))).toEqual([]);
    }
  });

  it("409s an agent name that collides with an existing HUMAN handle", async () => {
    // handleTaken's union semantics already existed; before this fix the agent
    // routes queried `agents` alone, so users/orgs were invisible to them.
    const username = `t139human${S}`;
    await db.insert(users).values({ email: `${username}@t.co`, username, passwordHash: "x" });
    const res = await register(username);
    expect(res.status).toBe(409);
    expect(await db.select().from(agents).where(eq(agents.name, username))).toEqual([]);
  });

  it("409s an agent name that collides with an existing ORG handle", async () => {
    const orgName = `t139org${S}`;
    const [owner] = await db.insert(users).values({ email: `own${S}@t.co`, username: `t139own${S}`, passwordHash: "x" }).returning();
    await db.insert(organizations).values({ name: orgName, ownerUserId: owner.id });
    const res = await register(orgName);
    expect(res.status).toBe(409);
    expect(await db.select().from(agents).where(eq(agents.name, orgName))).toEqual([]);
  });

  it("still creates an ordinary agent", async () => {
    const name = `t139ok${S}`;
    const res = await register(name);
    expect(res.status).toBe(201);
    expect((await res.json() as { agent: { name: string } }).agent.name).toBe(name);
  });

  it("assertHandleAvailable is the one shared predicate both create paths call", async () => {
    await expect(assertHandleAvailable(db, "gh-mirror")).rejects.toThrow(/reserved/i);
    await expect(assertHandleAvailable(db, `t139ok${S}`)).rejects.toThrow(/already taken/i);
    await expect(assertHandleAvailable(db, `t139free${S}`)).resolves.toBeUndefined();
  });

  it("never mints a reserved handle for a human whose email starts that way", async () => {
    // deriveUniqueUsername is the human side of the same namespace.
    const derived = await deriveUniqueUsername(db, "gh-mirror@example.com");
    expect(derived).not.toBe("gh-mirror");
    expect(isReservedHandle(derived)).toBe(false);
  });
});

describe.skipIf(!hasTestDb)("service users are never adopted by a foreign agent (#139, layer 2)", () => {
  let base: string;
  let git: GitService;
  let ghMirrorUserId: string;
  let squatter: typeof agents.$inferSelect;
  let honest: typeof agents.$inferSelect;
  let shadowRepo: { id: string };
  let publicRepo: { id: string; name: string };
  let publicOwner: { id: string; username: string };

  // Construct the agent row DIRECTLY, simulating a row that predates the
  // reserved list (layer 1 now blocks the route). Layer 2 must hold anyway.
  async function mkAgent(name: string) {
    const [a] = await db.insert(agents).values({
      name, tokenHash: await hashToken(randomToken(12)),
      gitAuthorName: name, gitAuthorEmail: `${name}@agents.test`,
    }).returning();
    return a;
  }

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "clawhub-139b-"));
    git = new GitService(base);

    // `agents.name` is globally unique and this suite must construct a row on
    // the literal reserved name, so clear any leftover from a previous run —
    // otherwise the whole suite silently SKIPS on a re-run (which is how a
    // layer-2 regression would slip through unnoticed).
    await db.delete(agents).where(eq(agents.name, "gh-mirror"));
    // Ditto for the platform user row: the last test below mutates its email to
    // prove the provisioner fails loudly, so normalize before provisioning.
    await db.update(users).set({ email: MIRROR_USER_EMAIL }).where(eq(users.username, "gh-mirror"));
    await db.update(users).set({ email: SYSTEM_USER_EMAIL }).where(eq(users.username, "clawhub-system"));

    // The platform namespace, provisioned the way ClawHub provisions it.
    ghMirrorUserId = (await ensureGhMirrorUser(db)).userId;
    // A private shadow repo under it — the prize.
    const [sr] = await db.insert(repositories).values({
      name: `t139shadow${S}`, namespaceType: "user", namespaceId: ghMirrorUserId,
      defaultBranch: "main", isPublic: false,
    }).returning();
    shadowRepo = { id: sr.id };

    // A public repo the attacker may legitimately fork — the trigger.
    const pubName = `t139pub${S}`;
    const [po] = await db.insert(users).values({ email: `pub${S}@t.co`, username: `t139pubown${S}`, passwordHash: "x" }).returning();
    publicOwner = { id: po.id, username: po.username! };
    const [pr] = await db.insert(repositories).values({
      name: pubName, namespaceType: "user", namespaceId: po.id, defaultBranch: "main", isPublic: true,
    }).returning();
    publicRepo = { id: pr.id, name: pubName };
    await git.initBare(publicOwner.username, pubName);

    squatter = await mkAgent("gh-mirror");
    honest = await mkAgent(`t139honest${S}`);
  });

  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
    await db.delete(agents).where(eq(agents.name, "gh-mirror"));
  });

  it("forkRepo refuses to hand the platform namespace to a same-named agent", async () => {
    // The exploit's step 2: forking ANY public repo used to run
    // ensureServiceUserForAgent, which adopted `gh-mirror` by name.
    await expect(forkRepo(db, git, publicRepo.id, squatter.id, `t139fork${S}`))
      .rejects.toThrow(/reserved|taken/i);
    const after = (await db.select().from(agents).where(eq(agents.id, squatter.id)))[0];
    expect(after.serviceUserId).toBeNull();
  });

  it("ensureServiceUserForAgent itself refuses, whatever calls it", async () => {
    // resolveImportOwner is the second ungated call site; both funnel here.
    await expect(ensureServiceUserForAgent(db, squatter)).rejects.toThrow(/reserved|taken/i);
    const after = (await db.select().from(agents).where(eq(agents.id, squatter.id)))[0];
    expect(after.serviceUserId).toBeNull();
  });

  it("leaves the squatter with NO access to the shadow repo", async () => {
    // The payoff the issue describes: repo-access.ts:159 grants `write` when
    // agents.service_user_id === the repo's namespace id.
    const repo = (await db.select().from(repositories).where(eq(repositories.id, shadowRepo.id)))[0];
    const access = await repoAccessFor(db, repo, { kind: "agent", agentId: squatter.id, name: squatter.name });
    expect(access).toBe("none");
    const visible = await visibleRepoIds(db, { kind: "agent", agentId: squatter.id, name: squatter.name });
    expect(visible.has(shadowRepo.id)).toBe(false);
  });

  it("refuses to adopt a service user provisioned for a DIFFERENT agent", async () => {
    // Not just the reserved names: any service user belongs to exactly one
    // agent. Same name, different owner — the generic form of the bug.
    const other = await mkAgent(`t139other${S}`);
    const takenName = `t139taken${S}`;
    await db.insert(users).values({
      email: serviceUserEmail(other.id), username: takenName, name: takenName,
      kind: "service", passwordHash: "x",
    });
    const impostor = await mkAgent(takenName + "x");
    // Rename in place so the impostor's name matches the existing service user.
    await db.update(agents).set({ name: takenName }).where(eq(agents.id, impostor.id));
    const reloaded = (await db.select().from(agents).where(eq(agents.id, impostor.id)))[0];
    await expect(ensureServiceUserForAgent(db, reloaded)).rejects.toThrow(/taken/i);
    expect((await db.select().from(agents).where(eq(agents.id, impostor.id)))[0].serviceUserId).toBeNull();
  });

  it("still provisions an ordinary headless agent its OWN service user (no regression)", async () => {
    const uid = await ensureServiceUserForAgent(db, honest);
    const su = (await db.select().from(users).where(eq(users.id, uid)))[0];
    expect(su.kind).toBe("service");
    expect(su.username).toBe(honest.name);
    expect(su.email).toBe(serviceUserEmail(honest.id));
    // Idempotent: the second call short-circuits on the back-pointer, which is
    // also what keeps agents provisioned BEFORE this change working.
    const again = (await db.select().from(agents).where(eq(agents.id, honest.id)))[0];
    expect(again.serviceUserId).toBe(uid);
    expect(await ensureServiceUserForAgent(db, again)).toBe(uid);
  });

  it("platform provisioners fail LOUDLY rather than reuse a namespace held by another identity", async () => {
    // The mirror image: if `gh-mirror` ever IS held by someone else, the mirror
    // must not quietly hand every shadow repo to them.
    expect((await ensureGhMirrorUser(db)).userId).toBe(ghMirrorUserId); // its own row, reused
    const systemUserId = await ensureSystemUser(db);
    expect(await ensureSystemUser(db)).toBe(systemUserId); // idempotent

    // finally: these rows are GLOBAL (one per instance), so a failed assertion
    // must not leave the platform namespaces poisoned for the next run.
    try {
      await db.update(users).set({ email: `svc-someone-else${S}@clawhub.invalid` }).where(eq(users.id, ghMirrorUserId));
      await expect(ensureGhMirrorUser(db)).rejects.toThrow(/held by another identity/);
      await db.update(users).set({ email: `svc-someone-else2${S}@clawhub.invalid` }).where(eq(users.id, systemUserId));
      await expect(ensureSystemUser(db)).rejects.toThrow(/held by another identity/);
    } finally {
      await db.update(users).set({ email: MIRROR_USER_EMAIL }).where(eq(users.id, ghMirrorUserId));
      await db.update(users).set({ email: SYSTEM_USER_EMAIL }).where(eq(users.id, systemUserId));
    }
  });
});
