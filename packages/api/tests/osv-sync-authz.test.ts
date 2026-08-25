import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { users, vulnAdvisories } from "../src/models/schema.js";
import { hashPassword, signToken } from "../src/services/auth.js";
import { GitService } from "../src/services/git.js";
import { syncFromOsv } from "../src/services/osv-sync.js";

// #213 — POST /advisories/osv-sync let any signed-up user inject arbitrary
// advisories into the GLOBAL vuln table from an attacker-controlled server.
const ADMIN_EMAIL = `osv-admin-${Date.now()}@t.co`;
process.env.CLAWHUB_ADMIN_EMAILS = ADMIN_EMAIL;
process.env.JWT_SECRET ??= "test-secret-osv";

describe("syncFromOsv input validation (#213)", () => {
  const fake = {} as never; // never reaches the DB — validation throws first.
  it("rejects a non-array packageNames (was a raw 500 from for-of)", async () => {
    await expect(syncFromOsv(fake, { ecosystem: "npm", packageNames: "react" as never })).rejects.toThrow();
  });
  it("rejects an empty packageNames", async () => {
    await expect(syncFromOsv(fake, { ecosystem: "npm", packageNames: [] })).rejects.toThrow();
  });
  it("rejects an over-cap packageNames", async () => {
    await expect(syncFromOsv(fake, { ecosystem: "npm", packageNames: Array(101).fill("x") })).rejects.toThrow(/capped/);
  });
  it("rejects a non-allowlisted baseUrl", async () => {
    await expect(syncFromOsv(fake, { ecosystem: "npm", packageNames: ["react"], baseUrl: "https://attacker.example/v1" })).rejects.toThrow(/allowlist/);
  });
  it("rejects a missing ecosystem", async () => {
    await expect(syncFromOsv(fake, { packageNames: ["react"] } as never)).rejects.toThrow();
  });
});

describe.skipIf(!hasTestDb)("POST /advisories/osv-sync authz (#213)", () => {
  const S = Date.now();
  let app: Hono;
  let adminTok: string;
  let userTok: string;

  beforeAll(async () => {
    process.env.CLAWHUB_API_RATE_LIMIT ??= "100000";
    process.env.CLAWHUB_AUTH_RATE_LIMIT ??= "100000";
    const { buildApp } = await import("../src/app.js");
    const { EventBus } = await import("../src/services/events.js");
    const gitBase = await mkdtemp(join(tmpdir(), "clawhub-osv-test-"));
    app = buildApp({ db, git: new GitService(gitBase), events: new EventBus(), inProcessWorker: false });

    const [admin] = await db.insert(users).values({ email: ADMIN_EMAIL, username: `osvadm${S}`, passwordHash: await hashPassword("x") }).returning();
    adminTok = signToken({ kind: "user", userId: admin.id, email: admin.email, v: admin.tokenVersion });
    const [u] = await db.insert(users).values({ email: `osv-user-${S}@t.co`, username: `osvusr${S}`, passwordHash: await hashPassword("x") }).returning();
    userTok = signToken({ kind: "user", userId: u.id, email: u.email, v: u.tokenVersion });
  });

  afterEach(() => vi.unstubAllGlobals());

  const CLIENT_IP = `203.0.116.${(S % 200) + 1}`;
  function post(token: string, body: unknown) {
    return app.request("/api/v1/advisories/osv-sync", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": CLIENT_IP, authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it("a non-admin user is 403 and writes no row", async () => {
    const before = (await db.select().from(vulnAdvisories)).length;
    const res = await post(userTok, { ecosystem: "npm", packageNames: ["react"] });
    expect(res.status).toBe(403);
    const after = (await db.select().from(vulnAdvisories)).length;
    expect(after).toBe(before);
  });

  it("an admin with malformed packageNames gets 400, not 500", async () => {
    const res = await post(adminTok, { ecosystem: "npm", packageNames: "react" });
    expect(res.status).toBe(400);
  });

  it("an admin with a forged upstream payload writes advisory rows", async () => {
    // Contact the default allowlisted host; the fetch is stubbed to a forged doc.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      vulns: [{
        id: `FORGED-${S}`, summary: "attacker text",
        references: [{ url: "https://attacker.example/pwn" }],
        database_specific: { severity: "critical" },
        affected: [{ package: { ecosystem: "npm", name: "react" }, ranges: [{ type: "SEMVER", events: [] }] }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const res = await post(adminTok, { ecosystem: "npm", packageNames: ["react"] });
    expect(res.status).toBe(200);
    const body = await res.json() as { inserted: number };
    expect(body.inserted).toBeGreaterThanOrEqual(1);
    const row = (await db.select().from(vulnAdvisories).where(eq(vulnAdvisories.packageName, "react")).limit(1))[0];
    expect(row).toBeTruthy();
  });
});
