import { describe, expect, it } from "vitest";
import { validateModelForMode, AGENTIC_MODES } from "../src/services/standing-agents.js";
import { hasTestDb, testDb } from "./test-db.js";
import { accessRoles, agents, users } from "../src/models/schema.js";
import { and, eq } from "drizzle-orm";
import { ensurePersonalAgent } from "../src/services/personal-agent.js";
import { normalizePermissions, hasPermission } from "../src/services/permissions.js";

// v3 redesign P3 (docs/redesign-v3.md §3): default personal agent, model×mode
// validation, deterministic harness.

describe("model × mode validation (pure)", () => {
  it("rejects a non-agentic catalog model on an agentic mode (platform key)", () => {
    expect(() => validateModelForMode("platform", "deepseek/deepseek-v4-flash", "develop"))
      .toThrow(/model_not_agentic/);
    expect(() => validateModelForMode("platform", "deepseek/deepseek-v4-pro", "verify"))
      .toThrow(/model_not_agentic/);
  });

  it("allows non-agentic models for single-shot modes", () => {
    expect(() => validateModelForMode("platform", "deepseek/deepseek-v4-flash", "review")).not.toThrow();
    expect(() => validateModelForMode("platform", "deepseek/deepseek-v4-flash", "triage")).not.toThrow();
  });

  it("allows agentic models everywhere", () => {
    for (const mode of [...AGENTIC_MODES, "review"]) {
      expect(() => validateModelForMode("platform", "z-ai/glm-5.2", mode)).not.toThrow();
    }
  });

  it("BYO rows are untouched (model names are CLI aliases, not catalog slugs)", () => {
    expect(() => validateModelForMode("byo", "deepseek/deepseek-v4-flash", "develop")).not.toThrow();
    expect(() => validateModelForMode(undefined, "sonnet", "develop")).not.toThrow();
  });
});

describe.skipIf(!hasTestDb)("default personal agent (db)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("creates ONE dormant agent with the Developer role; idempotent", async () => {
    const handle = `newbie-${uniq()}`;
    const [u] = await testDb.insert(users).values({
      email: `${handle}@t.local`, username: handle, passwordHash: "x",
    }).returning();

    const first = await ensurePersonalAgent(testDb, u.id, handle);
    expect(first.isPersonal).toBe(true);
    expect(first.name).toBe(`${handle}-agent`);
    expect(first.associatedUserId).toBe(u.id);
    // Developer role attached — push + review, never merge.
    expect(first.accessRoleId).toBeTruthy();
    const role = (await testDb.select().from(accessRoles).where(eq(accessRoles.id, first.accessRoleId!)).limit(1))[0];
    expect(role.name).toBe("Developer");
    const perms = normalizePermissions(role.permissions);
    expect(hasPermission(perms, "repo:write")).toBe(true);
    expect(hasPermission(perms, "change:merge")).toBe(false);

    // Idempotent: a second call returns the same identity, no duplicate.
    const second = await ensurePersonalAgent(testDb, u.id, handle);
    expect(second.id).toBe(first.id);
    const all = await testDb.select().from(agents)
      .where(and(eq(agents.associatedUserId, u.id), eq(agents.isPersonal, true)));
    expect(all.length).toBe(1);
  });
});
