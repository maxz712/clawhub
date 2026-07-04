import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/models/db.js";
import { agents, issues, issueRoutingRules, repoCollaborators, repositories, users } from "../src/models/schema.js";
import { applyIssueRouting, setIssueRoutingRule } from "../src/services/issue-routing.js";

// N5 issue routing: deterministic label → agent assignment. Real DB (>=0052).
const S = Date.now();
let repoId: string, agentA: string, agentB: string, ungranted: string;

async function mkAgent(name: string): Promise<string> {
  const [a] = await db.insert(agents).values({
    name, tokenHash: "x", gitAuthorName: name, gitAuthorEmail: `${name}@t.co`,
  }).returning();
  return a.id;
}
async function mkIssue(num: number, labels: string[], assigned?: string): Promise<{ id: string; labels: unknown; assignedAgentId: string | null }> {
  const [i] = await db.insert(issues).values({
    repoId, number: num, title: `t${num}`, labels, assignedAgentId: assigned ?? null,
    createdByKind: "human", createdById: repoId, // createdById just needs to be a uuid
  }).returning();
  return { id: i.id, labels: i.labels, assignedAgentId: i.assignedAgentId };
}

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: `ir-${S}@t.co`, username: `iru${S}`, passwordHash: "x" }).returning();
  const [r] = await db.insert(repositories).values({ name: `irrepo${S}`, namespaceType: "user", namespaceId: u.id }).returning();
  repoId = r.id;
  agentA = await mkAgent(`ir-a-${S}`);
  agentB = await mkAgent(`ir-b-${S}`);
  ungranted = await mkAgent(`ir-x-${S}`);
  await db.insert(repoCollaborators).values({ repoId, agentId: agentA, role: "writer" });
  await db.insert(repoCollaborators).values({ repoId, agentId: agentB, role: "writer" });
  // `ungranted` intentionally gets NO collaborator grant.
});

describe("applyIssueRouting", () => {
  it("assigns an unassigned issue on an exact-label rule", async () => {
    await setIssueRoutingRule(db, repoId, { label: "bug", agentId: agentA });
    const issue = await mkIssue(1, ["bug"]);
    const routed = await applyIssueRouting(db, repoId, issue);
    expect(routed).toBe(agentA);
    const row = (await db.select().from(issues).where(eq(issues.id, issue.id)).limit(1))[0];
    expect(row.assignedAgentId).toBe(agentA);
  });

  it("does not override an explicit assignment", async () => {
    const issue = await mkIssue(2, ["bug"], agentB);
    const routed = await applyIssueRouting(db, repoId, issue);
    expect(routed).toBeNull();
  });

  it("higher priority wins across labels", async () => {
    await setIssueRoutingRule(db, repoId, { label: "*", agentId: agentB, priority: 10 });
    const issue = await mkIssue(3, ["bug"]); // matches both "bug"(p0) and "*"(p10)
    const routed = await applyIssueRouting(db, repoId, issue);
    expect(routed).toBe(agentB); // wildcard at higher priority wins
  });

  it("specific label beats wildcard at equal priority", async () => {
    await setIssueRoutingRule(db, repoId, { label: "feature", agentId: agentA, priority: 10 });
    const issue = await mkIssue(4, ["feature"]); // "feature"(p10) and "*"(p10)
    const routed = await applyIssueRouting(db, repoId, issue);
    expect(routed).toBe(agentA); // specific beats "*" at the same priority
  });

  it("skips a rule whose agent lost its collaborator grant", async () => {
    await setIssueRoutingRule(db, repoId, { label: "*", agentId: agentB, enabled: false, priority: 10 }); // disable the wildcard
    await db.insert(issueRoutingRules).values({ repoId, label: "sec", agentId: ungranted, priority: 99, enabled: true });
    const issue = await mkIssue(5, ["sec"]);
    const routed = await applyIssueRouting(db, repoId, issue);
    expect(routed).toBeNull(); // the only matching rule points to an ungranted agent → skipped
  });
});
