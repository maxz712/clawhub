import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { GitService } from "../src/services/git.js";
import {
  generateTokenWithSecret,
  verifyTokenWithSecret,
} from "../src/services/auth.js";

/**
 * v2 API integration tests.
 *
 * Uses a lightweight in-memory test app with real GitService and auth.
 * Changes use authorId/authorType instead of agentId, and status starts at pending_review.
 */
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
        canReview: true,
        reviewStats: null,
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
          can_review: agent.canReview,
          created_at: agent.createdAt,
        },
        token,
      }, 201);
    });

    // Auth middleware
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

    // Create repo
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
        ownerAgentId: payload.type === "agent" ? payload.sub : null,
        gitPath,
        description: body.description ?? null,
        defaultBranch: body.default_branch ?? "main",
        mergePolicy: { min_approvals: 1, agent_approvals_sufficient: true, self_review_allowed: false, escalation_overrides_merge: true },
        reviewerConfig: { reviewer_mode: "owner_agents", auto_assign: true },
        escalationPolicy: { rules: [] },
        createdAt: new Date(),
      };
      state.repos.set(repo.id, repo);

      return c.json({
        repository: {
          id: repo.id,
          name: repo.name,
          owner_id: repo.ownerId,
          git_path: repo.gitPath,
          description: repo.description,
          default_branch: repo.defaultBranch,
          created_at: repo.createdAt,
        },
      }, 201);
    });

    // Get repo
    app.get("/api/v1/repos/:id", requireAuth, async (c) => {
      const repo = state.repos.get(c.req.param("id"));
      if (!repo) {
        return c.json({ error: { code: "NOT_FOUND", message: "Repository not found" } }, 404);
      }
      return c.json({
        repository: {
          id: repo.id,
          name: repo.name,
          owner_id: repo.ownerId,
          git_path: repo.gitPath,
          description: repo.description,
          default_branch: repo.defaultBranch,
          created_at: repo.createdAt,
        },
      });
    });

    // Submit change (v2: uses authorId/authorType, status is pending_review)
    app.post("/api/v1/repos/:id/changes", requireAuth, async (c) => {
      const repoId = c.req.param("id");
      const payload = c.get("tokenPayload") as any;
      const body = await c.req.json();

      const repo = state.repos.get(repoId);
      if (!repo) {
        return c.json({ error: { code: "NOT_FOUND", message: "Repository not found" } }, 404);
      }

      if (!body.branch) {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "branch is required" } }, 400);
      }

      const authorId = payload.sub;
      const authorType = payload.type === "agent" ? "agent" : "human";

      const change = {
        id: crypto.randomUUID(),
        repoId,
        authorId,
        authorType,
        branch: body.branch,
        intent: body.intent ?? null,
        riskLevel: body.risk_level ?? "medium",
        scope: body.scope ?? [],
        decisions: body.decisions ?? [],
        status: "pending_review",
        escalated: false,
        escalationReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      state.changes.set(change.id, change);

      return c.json({
        change: {
          id: change.id,
          repo_id: change.repoId,
          author_id: change.authorId,
          author_type: change.authorType,
          intent: change.intent,
          status: change.status,
          risk_level: change.riskLevel,
          branch: change.branch,
          escalated: change.escalated,
        },
      }, 201);
    });

    // List changes
    app.get("/api/v1/repos/:id/changes", requireAuth, async (c) => {
      const repoId = c.req.param("id");
      const repo = state.repos.get(repoId);
      if (!repo) {
        return c.json({ error: { code: "NOT_FOUND", message: "Repository not found" } }, 404);
      }
      const repoChanges = Array.from(state.changes.values()).filter((ch) => ch.repoId === repoId);
      return c.json({
        changes: repoChanges.map((ch) => ({
          id: ch.id,
          repo_id: ch.repoId,
          author_id: ch.authorId,
          author_type: ch.authorType,
          intent: ch.intent,
          status: ch.status,
          branch: ch.branch,
        })),
      });
    });

    // Get specific change
    app.get("/api/v1/repos/:id/changes/:changeId", requireAuth, async (c) => {
      const changeId = c.req.param("changeId");
      const repoId = c.req.param("id");
      const change = state.changes.get(changeId);
      if (!change || change.repoId !== repoId) {
        return c.json({ error: { code: "NOT_FOUND", message: "Change not found" } }, 404);
      }
      return c.json({
        change: {
          id: change.id,
          repo_id: change.repoId,
          author_id: change.authorId,
          author_type: change.authorType,
          intent: change.intent,
          status: change.status,
          branch: change.branch,
          risk_level: change.riskLevel,
          escalated: change.escalated,
        },
      });
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
      expect(body.agent.can_review).toBe(true);
      expect(body.token).toBeDefined();

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
      state.agents.set(agentId, { id: agentId, name: "test-agent", ownerId: userId, canReview: true });
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

  describe("Change Operations (v2)", () => {
    async function setupRepoWithAgent(appAndState: ReturnType<typeof createTestApp>) {
      const { app, state } = appAndState;
      const userId = crypto.randomUUID();
      state.users.set(userId, { id: userId, email: "test@test.com" });
      const agentId = crypto.randomUUID();
      state.agents.set(agentId, { id: agentId, name: "test-agent", ownerId: userId, canReview: true });
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
      return { token, agentId, userId, repoId: createBody.repository.id, app };
    }

    it("should submit a change with v2 fields", async () => {
      const testApp = createTestApp();
      const { token, repoId, app, agentId } = await setupRepoWithAgent(testApp);

      const res = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          branch: "feature/greeting",
          intent: "Add greeting file",
          risk_level: "low",
          scope: ["hello.txt"],
          decisions: [{ decision: "Created new greeting file", reasoning: "User requested it" }],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.change).toBeDefined();
      expect(body.change.status).toBe("pending_review");
      expect(body.change.author_id).toBe(agentId);
      expect(body.change.author_type).toBe("agent");
      expect(body.change.risk_level).toBe("low");
      expect(body.change.escalated).toBe(false);
    });

    it("should reject change with missing branch", async () => {
      const testApp = createTestApp();
      const { token, repoId, app } = await setupRepoWithAgent(testApp);

      const res = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          intent: "Missing branch",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("should list changes for a repo", async () => {
      const testApp = createTestApp();
      const { token, repoId, app } = await setupRepoWithAgent(testApp);

      await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          branch: "feature/list-test",
          intent: "Test change",
        }),
      });

      const res = await app.request(`/api/v1/repos/${repoId}/changes`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.changes).toBeDefined();
      expect(body.changes.length).toBe(1);
      expect(body.changes[0].author_type).toBe("agent");
      expect(body.changes[0].status).toBe("pending_review");
    });

    it("should get a specific change", async () => {
      const testApp = createTestApp();
      const { token, repoId, app } = await setupRepoWithAgent(testApp);

      const createRes = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          branch: "feature/specific",
          intent: "Specific change",
        }),
      });
      const createBody = await createRes.json();
      const changeId = createBody.change.id;

      const res = await app.request(`/api/v1/repos/${repoId}/changes/${changeId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.change.id).toBe(changeId);
      expect(body.change.intent).toBe("Specific change");
      expect(body.change.author_type).toBe("agent");
    });

    it("should return 404 for non-existent change", async () => {
      const testApp = createTestApp();
      const { token, repoId, app } = await setupRepoWithAgent(testApp);

      const res = await app.request(
        `/api/v1/repos/${repoId}/changes/${crypto.randomUUID()}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(404);
    });
  });
});
