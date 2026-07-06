import { describe, expect, it } from "vitest";
import { agentToIdentity, identityDirectoryEnabled, identityKey, userToIdentity } from "../src/services/identities.js";
import { identityByHandle, visibleIdentities } from "../src/services/identities.js";
import { hasTestDb, testDb } from "./test-db.js";
import { agents, orgMembers, organizations, repoCollaborators, repositories, users } from "../src/models/schema.js";

// v3 identities (docs/redesign-v3.md §1): the projection over users + agents.

describe("identity projection (pure)", () => {
  const baseUser = {
    id: "11111111-1111-1111-1111-111111111111", email: "a@b.c", name: "Ada L", username: "ada",
    kind: "human", avatarUrl: "http://x/a.png", bio: "hi", passwordHash: "x", totpSecret: null,
    totpSecretNonce: null, totpLastStep: null, totpEnabled: false, tokenVersion: 0, termsVersion: 0,
    createdAt: new Date(),
  } as Parameters<typeof userToIdentity>[0];

  it("maps a user to a human identity", () => {
    const i = userToIdentity(baseUser);
    expect(i.kind).toBe("human");
    expect(i.handle).toBe("ada");
    expect(i.displayName).toBe("Ada L");
    expect(i.isSystem).toBe(false);
  });

  it("falls back to a synthetic handle when username is null", () => {
    const i = userToIdentity({ ...baseUser, username: null });
    expect(i.handle).toBe("user-11111111");
  });

  it("maps an agent to an agent identity with owner attribution", () => {
    const i = agentToIdentity({
      id: "22222222-2222-2222-2222-222222222222", name: "dev-bot", tokenHash: "x",
      claimToken: null, claimTokenExpiresAt: null,
      associatedUserId: baseUser.id, serviceUserId: null, isPersonal: false,
      gitAuthorName: "Dev Bot", gitAuthorEmail: "dev-bot@agents.local",
      capabilities: { push: true, review: true }, stats: {},
      createdAt: new Date(), archivedAt: null, isSystem: false,
      intelligence: null, accessRoleId: null, createdByUserId: null,
      avatarUrl: null, bio: null,
    } as Parameters<typeof agentToIdentity>[0]);
    expect(i.kind).toBe("agent");
    expect(i.handle).toBe("dev-bot");
    expect(i.displayName).toBe("Dev Bot");
    expect(i.ownerUserId).toBe(baseUser.id);
  });

  it("identityKey is stable and kind-disambiguated", () => {
    expect(identityKey("human", "x")).toBe("human:x");
    expect(identityKey("agent", "x")).toBe("agent:x");
  });

  it("directory kill switch reads env", () => {
    const prev = process.env.CLAWHUB_DISABLE_IDENTITY_DIRECTORY;
    delete process.env.CLAWHUB_DISABLE_IDENTITY_DIRECTORY;
    expect(identityDirectoryEnabled()).toBe(true);
    process.env.CLAWHUB_DISABLE_IDENTITY_DIRECTORY = "1";
    expect(identityDirectoryEnabled()).toBe(false);
    if (prev === undefined) delete process.env.CLAWHUB_DISABLE_IDENTITY_DIRECTORY;
    else process.env.CLAWHUB_DISABLE_IDENTITY_DIRECTORY = prev;
  });
});

describe.skipIf(!hasTestDb)("identities (db)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  async function mkUser(username: string) {
    return (await testDb.insert(users).values({
      email: `${username}@t.local`, username, passwordHash: "x", name: username,
    }).returning())[0];
  }

  it("identityByHandle resolves users before same-named agents", async () => {
    const handle = `dupe-${uniq()}`;
    const u = await mkUser(handle);
    await testDb.insert(agents).values({
      name: handle, tokenHash: "x", gitAuthorName: handle, gitAuthorEmail: `${handle}@a.local`,
    });
    const i = await identityByHandle(testDb, handle);
    expect(i?.kind).toBe("human");
    expect(i?.id).toBe(u.id);
  });

  it("archived agents do not resolve", async () => {
    const handle = `gone-${uniq()}`;
    await testDb.insert(agents).values({
      name: handle, tokenHash: "x", gitAuthorName: handle, gitAuthorEmail: `${handle}@a.local`,
      archivedAt: new Date(),
    });
    expect(await identityByHandle(testDb, handle)).toBeNull();
  });

  it("common context: sees org members + repo collaborators, not strangers", async () => {
    const caller = await mkUser(`caller-${uniq()}`);
    const teammate = await mkUser(`mate-${uniq()}`);
    const stranger = await mkUser(`stranger-${uniq()}`);
    const [org] = await testDb.insert(organizations).values({ name: `org-${uniq()}` }).returning();
    await testDb.insert(orgMembers).values([
      { orgId: org.id, userId: caller.id, role: "member" },
      { orgId: org.id, userId: teammate.id, role: "member" },
    ]);
    const [repo] = await testDb.insert(repositories).values({
      name: `repo-${uniq()}`, namespaceType: "org", namespaceId: org.id,
    }).returning();
    const [bot] = await testDb.insert(agents).values({
      name: `bot-${uniq()}`, tokenHash: "x", gitAuthorName: "b", gitAuthorEmail: "b@a.local",
    }).returning();
    await testDb.insert(repoCollaborators).values({ repoId: repo.id, agentId: bot.id, role: "writer" });

    const visible = await visibleIdentities(testDb, caller.id);
    expect(visible.has(identityKey("human", caller.id))).toBe(true);
    expect(visible.has(identityKey("human", teammate.id))).toBe(true);
    expect(visible.has(identityKey("agent", bot.id))).toBe(true);
    expect(visible.has(identityKey("human", stranger.id))).toBe(false);
    const mate = visible.get(identityKey("human", teammate.id));
    expect(mate?.sharedRepoIds).toContain(repo.id);
  });
});
