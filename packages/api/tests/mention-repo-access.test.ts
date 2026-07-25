import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, mentions, repoCollaborators, repositories, users } from "../src/models/schema.js";
import { resolveAndRecordMentions } from "../src/services/mentions.js";

// Issue #84: @-mention notifications must not leak private-repo content to
// arbitrary users. resolveAndRecordMentions is the single choke point that
// resolves + records + returns mention targets; it now filters every resolved
// identity through repoAccessFor so an outsider (no collaborator/owner/org
// relationship) is dropped BEFORE a mention row is recorded or delivered.
// Real DB — repoAccessFor exercises collaborator/owner queries.
const S = Date.now();

let owner: string, collabUser: string, outsiderUser: string;
let grantedAgent: string, ungrantedAgent: string;
let privateRepoId: string, publicRepoId: string;

async function mkUser(tag: string): Promise<{ id: string; username: string }> {
  const username = `m84-${tag}-${S}`;
  const [u] = await db.insert(users).values({ email: `${username}@t.co`, username, passwordHash: "x" }).returning();
  return { id: u.id, username };
}
async function mkAgent(tag: string): Promise<{ id: string; name: string }> {
  const name = `m84a-${tag}-${S}`;
  const [a] = await db.insert(agents).values({
    name, tokenHash: "x", gitAuthorName: name, gitAuthorEmail: `${name}@t.co`,
  }).returning();
  return { id: a.id, name };
}

describe.skipIf(!hasTestDb)("mention repo-access filtering (#84)", () => {
  let collabName: string, outsiderName: string, grantedName: string, ungrantedName: string;

  beforeAll(async () => {
    const o = await mkUser("owner");
    owner = o.id;
    const c = await mkUser("collab"); collabUser = c.id; collabName = c.username;
    const x = await mkUser("out"); outsiderUser = x.id; outsiderName = x.username;
    const ga = await mkAgent("ok"); grantedAgent = ga.id; grantedName = ga.name;
    const ua = await mkAgent("no"); ungrantedAgent = ua.id; ungrantedName = ua.name;

    const [priv] = await db.insert(repositories).values({
      name: `m84priv${S}`, namespaceType: "user", namespaceId: owner, isPublic: false,
    }).returning();
    privateRepoId = priv.id;
    const [pub] = await db.insert(repositories).values({
      name: `m84pub${S}`, namespaceType: "user", namespaceId: owner, isPublic: true,
    }).returning();
    publicRepoId = pub.id;

    // Human collaborator + agent collaborator on the PRIVATE repo only.
    await db.insert(repoCollaborators).values({ repoId: privateRepoId, userId: collabUser, role: "writer" });
    await db.insert(repoCollaborators).values({ repoId: privateRepoId, agentId: grantedAgent, role: "writer" });
  });

  const author = () => ({ kind: "human" as const, id: owner });

  it("drops mentions of identities with no access to a PRIVATE repo", async () => {
    const srcId = randomUUID();
    const text = `@${collabName} @${outsiderName} @${grantedName} @${ungrantedName}`;
    const got = await resolveAndRecordMentions(db, text, {
      repoId: privateRepoId, sourceKind: "issue", sourceId: srcId, author: author(),
    });
    const names = got.map(m => m.name).sort();
    // Owner-namespace collaborator (human) + granted agent are kept; the two
    // outsiders (no relationship to the private repo) are filtered out.
    expect(names).toEqual([collabName, grantedName].sort());
    expect(names).not.toContain(outsiderName);
    expect(names).not.toContain(ungrantedName);

    // No mention row was recorded for the filtered-out outsiders.
    const rows = await db.select().from(mentions).where(eq(mentions.sourceId, srcId));
    const recorded = rows.map(r => r.mentionedId).sort();
    expect(recorded).toEqual([collabUser, grantedAgent].sort());
    expect(recorded).not.toContain(outsiderUser);
    expect(recorded).not.toContain(ungrantedAgent);
  });

  it("keeps an outsider mention on a PUBLIC repo (public content is readable)", async () => {
    const got = await resolveAndRecordMentions(db, `@${outsiderName}`, {
      repoId: publicRepoId, sourceKind: "issue", sourceId: randomUUID(), author: author(),
    });
    expect(got.map(m => m.name)).toContain(outsiderName);
  });

  it("returns [] when repoId points at a repo that no longer exists", async () => {
    const got = await resolveAndRecordMentions(db, `@${collabName}`, {
      repoId: "00000000-0000-0000-0000-000000000000", sourceKind: "issue", sourceId: randomUUID(), author: author(),
    });
    expect(got).toEqual([]);
  });
});
