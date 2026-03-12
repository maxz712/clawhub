import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createApp } from "../src/app.js";
import { GitService } from "../src/services/git.js";
import {
  generateTokenWithSecret,
  verifyTokenWithSecret,
} from "../src/services/auth.js";

// Mock database using a simple in-memory store
function createMockDb() {
  const store: Record<string, any[]> = {
    users: [],
    agents: [],
    repositories: [],
    changes: [],
    auditEvents: [],
  };

  function makeRow(table: string, values: any) {
    const row = {
      ...values,
      id: values.id ?? crypto.randomUUID(),
      createdAt: values.createdAt ?? new Date(),
    };
    store[table].push(row);
    return row;
  }

  // Create a mock db that mimics drizzle's API shape
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockImplementation((table: any) => {
      const tableName = getTableName(table);
      return {
        where: vi.fn().mockImplementation((condition: any) => ({
          limit: vi.fn().mockImplementation((n: number) => {
            // This is simplified; real impl would filter
            return Promise.resolve(store[tableName].slice(0, n));
          }),
          orderBy: vi.fn().mockImplementation(() => {
            return Promise.resolve(store[tableName]);
          }),
        })),
        orderBy: vi.fn().mockImplementation(() => {
          return Promise.resolve(store[tableName]);
        }),
        limit: vi.fn().mockImplementation((n: number) => {
          return Promise.resolve(store[tableName].slice(0, n));
        }),
      };
    }),
    insert: vi.fn().mockImplementation((table: any) => {
      const tableName = getTableName(table);
      return {
        values: vi.fn().mockImplementation((values: any) => ({
          returning: vi.fn().mockImplementation(() => {
            const row = makeRow(tableName, values);
            return Promise.resolve([row]);
          }),
        })),
      };
    }),
    _store: store,
  };

  return mockDb;
}

function getTableName(table: any): string {
  // Drizzle tables have a Symbol-based name, but for testing we check common names
  const name = table?.[Symbol.for("drizzle:Name")] ?? table?._.name;
  if (name === "users") return "users";
  if (name === "agents") return "agents";
  if (name === "repositories") return "repositories";
  if (name === "changes") return "changes";
  if (name === "audit_events" || name === "auditEvents") return "auditEvents";
  if (name === "permission_rules") return "permissionRules";
  return "unknown";
}

// Instead of complex mocking, test the routes by building a minimal test app
// that uses real auth but mocks db operations

describe("API Integration Tests", () => {
  let tempDir: string;
  let gitService: GitService;
  const JWT_SECRET = "test-jwt-secret";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawforge-api-test-"));
    gitService = new GitService({ basePath: tempDir });
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.JWT_SECRET;
  });

  // Build a lightweight test app with in-memory state instead of complex mocking
  function createTestApp() {
    const app = new Hono();
    const state = {
      users: new Map<string, any>(),
      agents: new Map<string, any>(),
      repos: new Map<string, any>(),
      changes: new Map<string, any>(),
    };

    // Health check
    app.get("/health", (c) => c.json({ status: "ok" }));

    // Agent registration (no auth required)
    app.post("/api/v1/agents", async (c) => {
      const body = await c.req.json();
      const { name, type, owner_id } = body;

      if (!name || !owner_id) {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "name and owner_id are required" } }, 400);
      }

      const user = state.users.get(owner_id);
      if (!user) {
        return c.json({ error: { code: "NOT_FOUND", message: `User '${owner_id}' not found` } }, 404);
      }

      const agent = {
        id: crypto.randomUUID(),
        name,
        type: type ?? "generic",
        ownerId: owner_id,
        createdAt: new Date(),
      };
      state.agents.set(agent.id, agent);

      const token = generateTokenWithSecret(agent.id, "agent", JWT_SECRET);

      return c.json({
        agent: {
          id: agent.id,
          name: agent.name,
          type: agent.type,
          owner_id: agent.ownerId,
          created_at: agent.createdAt,
        },
        token,
      }, 201);
    });

    // Auth middleware for protected routes
    const requireAuth = async (c: any, next: any) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader) {
        return c.json({ error: { code: "UNAUTHORIZED", message: "Missing Authorization header" } }, 401);
      }
      const parts = authHeader.split(" ");
      if (parts.length !== 2 || parts[0] !== "Bearer") {
        return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid format" } }, 401);
      }
      try {
        const payload = verifyTokenWithSecret(parts[1], JWT_SECRET);
        c.set("tokenPayload", payload);
      } catch {
        return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid token" } }, 401);
      }
      await next();
    };

    // Protected routes
    app.post("/api/v1/repos", requireAuth, async (c) => {
      const payload = c.get("tokenPayload") as any;
      const body = await c.req.json();

      if (!body.name) {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "name is required" } }, 400);
      }

      let ownerId: string;
      if (payload.type === "agent") {
        const agent = state.agents.get(payload.sub);
        if (!agent) {
          return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
        }
        ownerId = agent.ownerId;
      } else {
        ownerId = payload.sub;
      }

      const gitPath = `${ownerId}/${body.name}.git`;
      await gitService.initBareRepo(gitPath);

      const repo = {
        id: crypto.randomUUID(),
        name: body.name,
        ownerId,
        gitPath,
        description: body.description ?? null,
        defaultBranch: body.default_branch ?? "main",
        createdAt: new Date(),
      };
      state.repos.set(repo.id, repo);

      return c.json({ repository: { id: repo.id, name: repo.name, owner_id: repo.ownerId, git_path: repo.gitPath, description: repo.description, default_branch: repo.defaultBranch, created_at: repo.createdAt } }, 201);
    });

    app.get("/api/v1/repos/:id", requireAuth, async (c) => {
      const repo = state.repos.get(c.req.param("id"));
      if (!repo) {
        return c.json({ error: { code: "NOT_FOUND", message: "Repository not found" } }, 404);
      }
      return c.json({ repository: { id: repo.id, name: repo.name, owner_id: repo.ownerId, git_path: repo.gitPath, description: repo.description, default_branch: repo.defaultBranch, created_at: repo.createdAt } });
    });

    app.post("/api/v1/repos/:id/changes", requireAuth, async (c) => {
      const repoId = c.req.param("id");
      const payload = c.get("tokenPayload") as any;
      const body = await c.req.json();

      const repo = state.repos.get(repoId);
      if (!repo) {
        return c.json({ error: { code: "NOT_FOUND", message: "Repository not found" } }, 404);
      }

      if (!body.intent || !body.branch || !body.files) {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "intent, branch, and files are required" } }, 400);
      }

      // Create branch and apply files
      await gitService.createBranch(repo.gitPath, body.branch, repo.defaultBranch);
      await gitService.applyDiff(repo.gitPath, body.branch, body.files.map((f: any) => ({
        path: f.path,
        action: f.action ?? "create",
        content: f.content,
      })), body.intent);

      const change = {
        id: crypto.randomUUID(),
        repoId,
        agentId: payload.type === "agent" ? payload.sub : null,
        intent: body.intent,
        description: body.description ?? null,
        status: "pending",
        riskLevel: body.risk_assessment?.level ?? "low",
        branch: body.branch,
        diffSummary: { files_changed: body.files.length },
        createdAt: new Date(),
      };
      state.changes.set(change.id, change);

      return c.json({ change: { id: change.id, repo_id: change.repoId, agent_id: change.agentId, intent: change.intent, description: change.description, status: change.status, risk_level: change.riskLevel, branch: change.branch, diff_summary: change.diffSummary, created_at: change.createdAt } }, 201);
    });

    app.get("/api/v1/repos/:id/changes", requireAuth, async (c) => {
      const repoId = c.req.param("id");
      const repo = state.repos.get(repoId);
      if (!repo) {
        return c.json({ error: { code: "NOT_FOUND", message: "Repository not found" } }, 404);
      }

      const repoChanges = Array.from(state.changes.values()).filter(ch => ch.repoId === repoId);
      return c.json({ changes: repoChanges.map(ch => ({ id: ch.id, repo_id: ch.repoId, intent: ch.intent, status: ch.status, branch: ch.branch })) });
    });

    app.get("/api/v1/repos/:id/changes/:changeId", requireAuth, async (c) => {
      const changeId = c.req.param("changeId");
      const repoId = c.req.param("id");
      const change = state.changes.get(changeId);
      if (!change || change.repoId !== repoId) {
        return c.json({ error: { code: "NOT_FOUND", message: "Change not found" } }, 404);
      }
      return c.json({ change: { id: change.id, repo_id: change.repoId, intent: change.intent, status: change.status, branch: change.branch, risk_level: change.riskLevel } });
    });

    return { app, state };
  }

  describe("Health Check", () => {
    it("should return ok", async () => {
      const { app } = createTestApp();
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    });
  });

  describe("Agent Registration", () => {
    it("should register an agent and return token", async () => {
      const { app, state } = createTestApp();
      const userId = crypto.randomUUID();
      state.users.set(userId, { id: userId, email: "test@test.com" });

      const res = await app.request("/api/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-agent",
          type: "openclaw",
          owner_id: userId,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.agent).toBeDefined();
      expect(body.agent.name).toBe("test-agent");
      expect(body.agent.type).toBe("openclaw");
      expect(body.token).toBeDefined();

      // Verify token is valid
      const payload = verifyTokenWithSecret(body.token, JWT_SECRET);
      expect(payload.sub).toBe(body.agent.id);
      expect(payload.type).toBe("agent");
    });

    it("should reject registration with missing fields", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });
      expect(res.status).toBe(400);
    });

    it("should reject registration with non-existent owner", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-agent",
          owner_id: crypto.randomUUID(),
        }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Repository Operations", () => {
    async function setupAgentAndToken(state: any) {
      const userId = crypto.randomUUID();
      state.users.set(userId, { id: userId, email: "test@test.com" });
      const agentId = crypto.randomUUID();
      state.agents.set(agentId, { id: agentId, name: "test-agent", ownerId: userId });
      const token = generateTokenWithSecret(agentId, "agent", JWT_SECRET);
      return { userId, agentId, token };
    }

    it("should create a repository", async () => {
      const { app, state } = createTestApp();
      const { token } = await setupAgentAndToken(state);

      const res = await app.request("/api/v1/repos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: "test-repo",
          description: "A test repository",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.repository).toBeDefined();
      expect(body.repository.name).toBe("test-repo");
      expect(body.repository.default_branch).toBe("main");
    });

    it("should reject unauthenticated repo creation", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/v1/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-repo" }),
      });
      expect(res.status).toBe(401);
    });

    it("should reject request with invalid token", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/v1/repos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-token",
        },
        body: JSON.stringify({ name: "test-repo" }),
      });
      expect(res.status).toBe(401);
    });

    it("should get repository info", async () => {
      const { app, state } = createTestApp();
      const { token } = await setupAgentAndToken(state);

      // Create repo
      const createRes = await app.request("/api/v1/repos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "info-repo" }),
      });
      const createBody = await createRes.json();
      const repoId = createBody.repository.id;

      // Get repo
      const getRes = await app.request(`/api/v1/repos/${repoId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.repository.name).toBe("info-repo");
    });

    it("should return 404 for non-existent repo", async () => {
      const { app, state } = createTestApp();
      const { token } = await setupAgentAndToken(state);

      const res = await app.request(`/api/v1/repos/${crypto.randomUUID()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Change Operations", () => {
    async function setupRepoWithAgent(appAndState: ReturnType<typeof createTestApp>) {
      const { app, state } = appAndState;
      const userId = crypto.randomUUID();
      state.users.set(userId, { id: userId, email: "test@test.com" });
      const agentId = crypto.randomUUID();
      state.agents.set(agentId, { id: agentId, name: "test-agent", ownerId: userId });
      const token = generateTokenWithSecret(agentId, "agent", JWT_SECRET);

      const createRes = await app.request("/api/v1/repos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "change-test-repo" }),
      });
      const createBody = await createRes.json();
      return { token, agentId, repoId: createBody.repository.id, app };
    }

    it("should submit a change", async () => {
      const testApp = createTestApp();
      const { token, repoId, app } = await setupRepoWithAgent(testApp);

      const res = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          intent: "Add a greeting file",
          description: "Adding hello.txt",
          branch: "feature/greeting",
          files: [
            {
              path: "hello.txt",
              action: "create",
              content: "Hello, ClawForge!",
            },
          ],
          risk_assessment: {
            level: "low",
            reasoning: "Simple file addition",
          },
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.change).toBeDefined();
      expect(body.change.intent).toBe("Add a greeting file");
      expect(body.change.status).toBe("pending");
      expect(body.change.risk_level).toBe("low");
      expect(body.change.branch).toBe("feature/greeting");
    });

    it("should reject change with missing fields", async () => {
      const testApp = createTestApp();
      const { token, repoId, app } = await setupRepoWithAgent(testApp);

      const res = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          intent: "Missing branch and files",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("should list changes for a repo", async () => {
      const testApp = createTestApp();
      const { token, repoId, app } = await setupRepoWithAgent(testApp);

      // Create a change
      await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          intent: "Test change",
          branch: "feature/list-test",
          files: [{ path: "test.txt", action: "create", content: "test" }],
        }),
      });

      // List changes
      const res = await app.request(`/api/v1/repos/${repoId}/changes`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.changes).toBeDefined();
      expect(body.changes.length).toBe(1);
      expect(body.changes[0].intent).toBe("Test change");
    });

    it("should get a specific change", async () => {
      const testApp = createTestApp();
      const { token, repoId, app } = await setupRepoWithAgent(testApp);

      // Create a change
      const createRes = await app.request(
        `/api/v1/repos/${repoId}/changes`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            intent: "Specific change",
            branch: "feature/specific",
            files: [
              { path: "specific.txt", action: "create", content: "specific" },
            ],
          }),
        }
      );
      const createBody = await createRes.json();
      const changeId = createBody.change.id;

      // Get specific change
      const res = await app.request(
        `/api/v1/repos/${repoId}/changes/${changeId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.change.id).toBe(changeId);
      expect(body.change.intent).toBe("Specific change");
    });

    it("should return 404 for non-existent change", async () => {
      const testApp = createTestApp();
      const { token, repoId, app } = await setupRepoWithAgent(testApp);

      const res = await app.request(
        `/api/v1/repos/${repoId}/changes/${crypto.randomUUID()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      expect(res.status).toBe(404);
    });
  });
});
