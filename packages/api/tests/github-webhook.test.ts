import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { githubInstallations } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { ChangeRefService } from "../src/services/change-refs.js";
import { EventBus } from "../src/services/events.js";
import { createGithubAppRoutes } from "../src/routes/github-app.js";

// N2 GitHub App webhook intake: HMAC gate + event routing + installation
// persistence, against the real DB (migrate the test DB to >=0052 first).
const SECRET = "whsec_test_n2";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

let appRoutes: ReturnType<typeof createGithubAppRoutes>;
const INSTALL_ID = String(900_000_000 + Math.floor(Date.now() % 1_000_000));

async function post(event: string, body: unknown, sig?: string) {
  const raw = JSON.stringify(body);
  return appRoutes.request("/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": sig ?? sign(raw) },
    body: raw,
  });
}

describe.skipIf(!hasTestDb)("N2 github webhook", () => {
  beforeAll(() => {
    process.env.GITHUB_APP_ID = "4217155";
    process.env.GITHUB_APP_PRIVATE_KEY = PEM.replace(/\n/g, "\\n");
    process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
    const git = new GitService(process.env.GIT_REPOS_BASE_PATH ?? "./data/test-repos");
    appRoutes = createGithubAppRoutes(db, git, new ChangeRefService(git), new EventBus());
  });

  afterEach(async () => {
    await db.delete(githubInstallations).where(eq(githubInstallations.installationId, INSTALL_ID));
  });

  it("GET /app reports configured", async () => {
    const res = await appRoutes.request("/app");
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.configured).toBe(true);
    expect(json.appId).toBe("4217155");
  });

  it("rejects a bad signature with 401", async () => {
    const res = await post("ping", { zen: "hi" }, "sha256=deadbeef");
    expect(res.status).toBe(401);
  });

  it("accepts a ping with a valid signature", async () => {
    const res = await post("ping", { zen: "Keep it logically awesome." });
    expect(res.status).toBe(200);
  });

  it("persists installation.created and removes on deleted", async () => {
    const created = await post("installation", {
      action: "created",
      installation: { id: Number(INSTALL_ID), account: { login: "octo-test", id: 42, type: "User" }, repository_selection: "selected" },
      sender: { login: "octo-test", id: 42 },
    });
    expect(created.status).toBe(200);
    const row = (await db.select().from(githubInstallations).where(eq(githubInstallations.installationId, INSTALL_ID)).limit(1))[0];
    expect(row).toBeTruthy();
    expect(row.accountLogin).toBe("octo-test");

    const deleted = await post("installation", { action: "deleted", installation: { id: Number(INSTALL_ID) } });
    expect(deleted.status).toBe(200);
    const gone = (await db.select().from(githubInstallations).where(eq(githubInstallations.installationId, INSTALL_ID)).limit(1))[0];
    expect(gone).toBeUndefined();
  });

  it("ignores a pull_request action that isn't opened/synchronize/reopened", async () => {
    const res = await post("pull_request", {
      action: "closed",
      installation: { id: Number(INSTALL_ID) },
      repository: { name: "r", owner: { login: "o" } },
      pull_request: { number: 5, state: "closed" },
    });
    expect(res.status).toBe(200); // ignored, but acknowledged
  });
});
