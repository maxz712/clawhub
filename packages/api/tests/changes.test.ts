import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { GitService } from "../src/services/git.js";
import { IntentEngine } from "../src/services/intent.js";
import { EventBus } from "../src/services/events.js";
import {
  generateTokenWithSecret,
  verifyTokenWithSecret,
} from "../src/services/auth.js";

/**
 * Integration tests for the Week 2 change processing pipeline:
 * - Permission checks on submission
 * - Intent engine risk classification
 * - Status machine transitions (approve/reject/merge/rollback)
 * - Git branch management (merge on approval)
 * - Audit event logging
 * - Event emission
 */
describe("Change Processing Pipeline", () => {
  let tempDir: string;
  let gitService: GitService;
  const JWT_SECRET = "test-jwt-secret";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawforge-changes-test-"));
    gitService = new GitService({ basePath: tempDir });
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.JWT_SECRET;
  });

  // Build a test app with in-memory DB that supports the full Week 2 pipeline
  function createTestApp() {
    const app = new Hono();
    const state = {
      users: new Map<string, any>(),
      agents: new Map<string, any>(),
      repos: new Map<string, any>(),
      changes: new Map<string, any>(),
      permissionRules: new Map<string, any>(),
      auditEvents: [] as any[],
    };

    const intentEngine = new IntentEngine({ apiKey: undefined }); // heuristic mode
    const eventBus = new EventBus(undefined); // no Redis, log-only

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

    // Agent registration
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
      const agent = { id: crypto.randomUUID(), name, type: type ?? "generic", ownerId: owner_id, createdAt: new Date() };
      state.agents.set(agent.id, agent);
      const token = generateTokenWithSecret(agent.id, "agent", JWT_SECRET);
      return c.json({ agent: { id: agent.id, name: agent.name, type: agent.type, owner_id: agent.ownerId, created_at: agent.createdAt }, token }, 201);
    });

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
        if (!agent) return c.json({ error: { code: "NOT_FOUND" } }, 404);
        ownerId = agent.ownerId;
      } else {
        ownerId = payload.sub;
      }
      const gitPath = `${ownerId}/${body.name}.git`;
      await gitService.initBareRepo(gitPath);
      const repo = { id: crypto.randomUUID(), name: body.name, ownerId, gitPath, description: null, defaultBranch: "main", createdAt: new Date() };
      state.repos.set(repo.id, repo);
      return c.json({ repository: { id: repo.id, name: repo.name, owner_id: repo.ownerId, git_path: repo.gitPath, default_branch: repo.defaultBranch } }, 201);
    });

    // Submit change (with permission check + intent analysis)
    app.post("/api/v1/repos/:id/changes", requireAuth, async (c) => {
      const repoId = c.req.param("id");
      const payload = c.get("tokenPayload") as any;
      const body = await c.req.json();
      const repo = state.repos.get(repoId);
      if (!repo) return c.json({ error: { code: "NOT_FOUND" } }, 404);
      if (!body.intent || !body.branch || !body.files) {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "intent, branch, and files are required" } }, 400);
      }

      const agentId = payload.type === "agent" ? payload.sub : null;
      const filePaths = body.files.map((f: any) => f.path);
      const fileActions = body.files.map((f: any) => f.action ?? "create");

      // Permission check
      const { evaluatePermissions } = await import("../src/services/permissions.js");
      const rules = Array.from(state.permissionRules.values()).filter((r: any) => r.repoId === repoId);
      const permResult = evaluatePermissions(rules, agentId, filePaths, fileActions);

      if (!permResult.allowed) {
        return c.json({ error: { code: "PERMISSION_DENIED", message: `Access denied for paths: ${permResult.deniedPaths.join(", ")}` } }, 403);
      }

      // Intent analysis
      const analysis = await intentEngine.analyzeChange({
        intent: body.intent,
        description: body.description,
        files: body.files,
        existingRiskLevel: body.risk_assessment?.level,
      });

      // Git operations
      await gitService.createBranch(repo.gitPath, body.branch, repo.defaultBranch);
      await gitService.applyDiff(repo.gitPath, body.branch, body.files.map((f: any) => ({
        path: f.path, action: f.action ?? "create", content: f.content,
      })), body.intent);

      // Determine initial status
      let initialStatus = "pending";
      if (permResult.autoMerge && !permResult.requiresApproval && (analysis.riskLevel === "low" || analysis.riskLevel === "medium")) {
        initialStatus = "approved";
      }

      const change = {
        id: crypto.randomUUID(),
        repoId,
        agentId,
        intent: body.intent,
        description: analysis.summary,
        status: initialStatus,
        riskLevel: analysis.riskLevel,
        branch: body.branch,
        diffSummary: { files_changed: body.files.length },
        semanticDiff: { architectural_impact: analysis.architecturalImpact },
        createdAt: new Date(),
        reviewedAt: null as Date | null,
        reviewedBy: null as string | null,
      };

      // Auto-merge if approved
      if (initialStatus === "approved") {
        await gitService.mergeBranch(repo.gitPath, body.branch, repo.defaultBranch);
        change.status = "merged";
      }

      state.changes.set(change.id, change);
      state.auditEvents.push({ action: "change_created", changeId: change.id, riskLevel: analysis.riskLevel });

      await eventBus.emit({ type: "change.created", repoId, data: { changeId: change.id }, timestamp: new Date().toISOString() });

      return c.json({ change: { id: change.id, repo_id: change.repoId, agent_id: change.agentId, intent: change.intent, description: change.description, status: change.status, risk_level: change.riskLevel, branch: change.branch } }, 201);
    });

    // Get change
    app.get("/api/v1/repos/:id/changes/:changeId", requireAuth, async (c) => {
      const change = state.changes.get(c.req.param("changeId"));
      if (!change || change.repoId !== c.req.param("id")) {
        return c.json({ error: { code: "NOT_FOUND" } }, 404);
      }
      return c.json({ change: { id: change.id, status: change.status, risk_level: change.riskLevel, reviewed_at: change.reviewedAt, reviewed_by: change.reviewedBy } });
    });

    // Approve
    app.post("/api/v1/repos/:id/changes/:changeId/approve", requireAuth, async (c) => {
      const payload = c.get("tokenPayload") as any;
      if (payload.type !== "user") {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "Only users can approve" } }, 400);
      }
      const change = state.changes.get(c.req.param("changeId"));
      if (!change || change.repoId !== c.req.param("id")) {
        return c.json({ error: { code: "NOT_FOUND" } }, 404);
      }
      if (change.status !== "pending") {
        return c.json({ error: { code: "VALIDATION_ERROR", message: `Cannot transition from '${change.status}' to 'approved'` } }, 400);
      }
      change.status = "approved";
      change.reviewedAt = new Date();
      change.reviewedBy = payload.sub;
      state.auditEvents.push({ action: "change_approved", changeId: change.id });
      return c.json({ change: { id: change.id, status: change.status, reviewed_by: change.reviewedBy } });
    });

    // Reject
    app.post("/api/v1/repos/:id/changes/:changeId/reject", requireAuth, async (c) => {
      const payload = c.get("tokenPayload") as any;
      if (payload.type !== "user") {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "Only users can reject" } }, 400);
      }
      const change = state.changes.get(c.req.param("changeId"));
      if (!change || change.repoId !== c.req.param("id")) {
        return c.json({ error: { code: "NOT_FOUND" } }, 404);
      }
      if (change.status !== "pending" && change.status !== "approved") {
        return c.json({ error: { code: "VALIDATION_ERROR", message: `Cannot transition from '${change.status}' to 'rejected'` } }, 400);
      }
      change.status = "rejected";
      change.reviewedAt = new Date();
      change.reviewedBy = payload.sub;
      state.auditEvents.push({ action: "change_rejected", changeId: change.id });
      return c.json({ change: { id: change.id, status: change.status } });
    });

    // Merge
    app.post("/api/v1/repos/:id/changes/:changeId/merge", requireAuth, async (c) => {
      const payload = c.get("tokenPayload") as any;
      if (payload.type !== "user") {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "Only users can merge" } }, 400);
      }
      const change = state.changes.get(c.req.param("changeId"));
      if (!change || change.repoId !== c.req.param("id")) {
        return c.json({ error: { code: "NOT_FOUND" } }, 404);
      }
      if (change.status !== "approved") {
        return c.json({ error: { code: "VALIDATION_ERROR", message: `Cannot merge from '${change.status}'` } }, 400);
      }
      const repo = state.repos.get(change.repoId);
      await gitService.mergeBranch(repo.gitPath, change.branch, repo.defaultBranch);
      change.status = "merged";
      change.reviewedBy = payload.sub;
      state.auditEvents.push({ action: "change_merged", changeId: change.id });
      return c.json({ change: { id: change.id, status: change.status } });
    });

    // Rollback
    app.post("/api/v1/repos/:id/changes/:changeId/rollback", requireAuth, async (c) => {
      const payload = c.get("tokenPayload") as any;
      if (payload.type !== "user") {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "Only users can rollback" } }, 400);
      }
      const change = state.changes.get(c.req.param("changeId"));
      if (!change || change.repoId !== c.req.param("id")) {
        return c.json({ error: { code: "NOT_FOUND" } }, 404);
      }
      if (change.status !== "merged") {
        return c.json({ error: { code: "VALIDATION_ERROR", message: `Cannot rollback from '${change.status}'` } }, 400);
      }
      const repo = state.repos.get(change.repoId);
      await gitService.rollbackMerge(repo.gitPath, repo.defaultBranch);
      change.status = "rolled_back";
      change.reviewedBy = payload.sub;
      state.auditEvents.push({ action: "change_rolled_back", changeId: change.id });
      return c.json({ change: { id: change.id, status: change.status } });
    });

    // Permission rules CRUD
    app.post("/api/v1/repos/:id/permissions", requireAuth, async (c) => {
      const payload = c.get("tokenPayload") as any;
      if (payload.type !== "user") {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "Only users can manage permissions" } }, 400);
      }
      const repoId = c.req.param("id");
      const body = await c.req.json();
      if (!body.rule_type || !body.pattern) {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "rule_type and pattern are required" } }, 400);
      }
      const rule = {
        id: crypto.randomUUID(),
        repoId,
        agentId: body.agent_id ?? null,
        ruleType: body.rule_type,
        pattern: body.pattern,
        conditions: body.conditions ?? null,
      };
      state.permissionRules.set(rule.id, rule);
      return c.json({ permission_rule: { id: rule.id, repo_id: rule.repoId, rule_type: rule.ruleType, pattern: rule.pattern } }, 201);
    });

    app.get("/api/v1/repos/:id/permissions", requireAuth, async (c) => {
      const repoId = c.req.param("id");
      const rules = Array.from(state.permissionRules.values()).filter((r: any) => r.repoId === repoId);
      return c.json({ permission_rules: rules });
    });

    app.delete("/api/v1/repos/:id/permissions/:ruleId", requireAuth, async (c) => {
      const payload = c.get("tokenPayload") as any;
      if (payload.type !== "user") {
        return c.json({ error: { code: "VALIDATION_ERROR" } }, 400);
      }
      const ruleId = c.req.param("ruleId");
      if (!state.permissionRules.has(ruleId)) {
        return c.json({ error: { code: "NOT_FOUND" } }, 404);
      }
      state.permissionRules.delete(ruleId);
      return c.json({ deleted: true });
    });

    return { app, state };
  }

  async function setupRepoWithAgent(appAndState: ReturnType<typeof createTestApp>) {
    const { app, state } = appAndState;
    const userId = crypto.randomUUID();
    state.users.set(userId, { id: userId, email: "test@test.com" });
    const agentId = crypto.randomUUID();
    state.agents.set(agentId, { id: agentId, name: "test-agent", ownerId: userId });
    const agentToken = generateTokenWithSecret(agentId, "agent", JWT_SECRET);
    const userToken = generateTokenWithSecret(userId, "user", JWT_SECRET);

    const createRes = await app.request("/api/v1/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ name: `repo-${Date.now()}` }),
    });
    const createBody = await createRes.json();
    return { agentToken, userToken, agentId, userId, repoId: createBody.repository.id, app, state };
  }

  describe("Change Submission with Permission Check", () => {
    it("should submit a change and get pending status (default)", async () => {
      const testApp = createTestApp();
      const { agentToken, repoId, app } = await setupRepoWithAgent(testApp);

      const res = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Add greeting file",
          branch: "feature/greeting",
          files: [{ path: "hello.txt", action: "create", content: "Hello!" }],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.change.status).toBe("pending");
      expect(body.change.risk_level).toBe("low");
    });

    it("should deny change when deny_path rule matches", async () => {
      const testApp = createTestApp();
      const { agentToken, userToken, repoId, app, state } = await setupRepoWithAgent(testApp);

      // Create deny rule
      await app.request(`/api/v1/repos/${repoId}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({ rule_type: "deny_path", pattern: "src/auth/**" }),
      });

      // Try to submit a change touching auth files
      const res = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Modify auth",
          branch: "feature/auth-fix",
          files: [{ path: "src/auth/login.ts", action: "modify", content: "..." }],
        }),
      });

      expect(res.status).toBe(403);
    });

    it("should auto-merge low-risk changes with auto_merge rule", async () => {
      const testApp = createTestApp();
      const { agentToken, userToken, repoId, app } = await setupRepoWithAgent(testApp);

      // Create auto_merge rule for docs
      await app.request(`/api/v1/repos/${repoId}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({ rule_type: "auto_merge", pattern: "docs/**" }),
      });

      const res = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Update docs",
          branch: "docs/update",
          files: [{ path: "docs/readme.md", action: "create", content: "# Docs" }],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.change.status).toBe("merged");
    });

    it("should classify risk using intent engine heuristics", async () => {
      const testApp = createTestApp();
      const { agentToken, repoId, app } = await setupRepoWithAgent(testApp);

      const res = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Update database schema",
          branch: "feature/schema",
          files: [{ path: "src/models/schema.ts", action: "modify", content: "..." }],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      // schema.ts should be classified as medium risk by heuristic
      expect(["medium", "high"]).toContain(body.change.risk_level);
    });
  });

  describe("Change Status Machine", () => {
    it("should approve a pending change", async () => {
      const testApp = createTestApp();
      const { agentToken, userToken, repoId, app } = await setupRepoWithAgent(testApp);

      // Submit change
      const createRes = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Add file",
          branch: "feature/add",
          files: [{ path: "new.txt", action: "create", content: "new" }],
        }),
      });
      const changeId = (await createRes.json()).change.id;

      // Approve
      const approveRes = await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });

      expect(approveRes.status).toBe(200);
      const body = await approveRes.json();
      expect(body.change.status).toBe("approved");
      expect(body.change.reviewed_by).toBeTruthy();
    });

    it("should reject a pending change", async () => {
      const testApp = createTestApp();
      const { agentToken, userToken, repoId, app } = await setupRepoWithAgent(testApp);

      const createRes = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Bad change",
          branch: "feature/bad",
          files: [{ path: "bad.txt", action: "create", content: "bad" }],
        }),
      });
      const changeId = (await createRes.json()).change.id;

      const rejectRes = await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({ reason: "Not needed" }),
      });

      expect(rejectRes.status).toBe(200);
      expect((await rejectRes.json()).change.status).toBe("rejected");
    });

    it("should merge an approved change", async () => {
      const testApp = createTestApp();
      const { agentToken, userToken, repoId, app } = await setupRepoWithAgent(testApp);

      const createRes = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Add feature",
          branch: "feature/merge-test",
          files: [{ path: "feature.ts", action: "create", content: "export const x = 1;" }],
        }),
      });
      const changeId = (await createRes.json()).change.id;

      // Approve first
      await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });

      // Then merge
      const mergeRes = await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/merge`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });

      expect(mergeRes.status).toBe(200);
      expect((await mergeRes.json()).change.status).toBe("merged");
    });

    it("should rollback a merged change", async () => {
      const testApp = createTestApp();
      const { agentToken, userToken, repoId, app } = await setupRepoWithAgent(testApp);

      const createRes = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Rollback test",
          branch: "feature/rollback-test",
          files: [{ path: "rollback.ts", action: "create", content: "oops" }],
        }),
      });
      const changeId = (await createRes.json()).change.id;

      await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });

      await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/merge`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });

      const rollbackRes = await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/rollback`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });

      expect(rollbackRes.status).toBe(200);
      expect((await rollbackRes.json()).change.status).toBe("rolled_back");
    });

    it("should prevent invalid transitions", async () => {
      const testApp = createTestApp();
      const { agentToken, userToken, repoId, app } = await setupRepoWithAgent(testApp);

      const createRes = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Invalid transition test",
          branch: "feature/invalid",
          files: [{ path: "test.txt", action: "create", content: "x" }],
        }),
      });
      const changeId = (await createRes.json()).change.id;

      // Try to merge a pending change (should fail)
      const mergeRes = await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/merge`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(mergeRes.status).toBe(400);

      // Try to rollback a pending change (should fail)
      const rollbackRes = await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/rollback`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(rollbackRes.status).toBe(400);
    });

    it("should prevent agents from approving changes", async () => {
      const testApp = createTestApp();
      const { agentToken, repoId, app } = await setupRepoWithAgent(testApp);

      const createRes = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Agent approve test",
          branch: "feature/agent-approve",
          files: [{ path: "test.txt", action: "create", content: "x" }],
        }),
      });
      const changeId = (await createRes.json()).change.id;

      const approveRes = await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${agentToken}` },
      });
      expect(approveRes.status).toBe(400);
    });
  });

  describe("Permission Rule CRUD", () => {
    it("should create, list, and delete permission rules", async () => {
      const testApp = createTestApp();
      const { userToken, repoId, app } = await setupRepoWithAgent(testApp);

      // Create
      const createRes = await app.request(`/api/v1/repos/${repoId}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({ rule_type: "deny_path", pattern: "*.env" }),
      });
      expect(createRes.status).toBe(201);
      const ruleId = (await createRes.json()).permission_rule.id;

      // List
      const listRes = await app.request(`/api/v1/repos/${repoId}/permissions`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(listRes.status).toBe(200);
      const rules = (await listRes.json()).permission_rules;
      expect(rules.length).toBe(1);

      // Delete
      const deleteRes = await app.request(`/api/v1/repos/${repoId}/permissions/${ruleId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(deleteRes.status).toBe(200);

      // Verify deleted
      const listRes2 = await app.request(`/api/v1/repos/${repoId}/permissions`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect((await listRes2.json()).permission_rules.length).toBe(0);
    });

    it("should prevent agents from managing permissions", async () => {
      const testApp = createTestApp();
      const { agentToken, repoId, app } = await setupRepoWithAgent(testApp);

      const res = await app.request(`/api/v1/repos/${repoId}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({ rule_type: "deny_path", pattern: "**" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Full Pipeline: Submit → Approve → Merge", () => {
    it("should handle the complete change lifecycle with git verification", async () => {
      const testApp = createTestApp();
      const { agentToken, userToken, repoId, app, state } = await setupRepoWithAgent(testApp);
      const repo = state.repos.get(repoId);

      // Submit change
      const createRes = await app.request(`/api/v1/repos/${repoId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          intent: "Add hello module",
          branch: "feature/hello",
          files: [{ path: "src/hello.ts", action: "create", content: 'export const hello = "world";' }],
        }),
      });
      expect(createRes.status).toBe(201);
      const changeId = (await createRes.json()).change.id;

      // Verify branch was created in git
      const branchFiles = await gitService.listFiles(repo.gitPath, "feature/hello");
      expect(branchFiles).toContain("src/hello.ts");

      // Verify main branch doesn't have the file yet
      const mainFiles = await gitService.listFiles(repo.gitPath, "main");
      expect(mainFiles).not.toContain("src/hello.ts");

      // Approve
      await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });

      // Merge
      await app.request(`/api/v1/repos/${repoId}/changes/${changeId}/merge`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });

      // Verify file is now on main branch
      const mainFilesAfter = await gitService.listFiles(repo.gitPath, "main");
      expect(mainFilesAfter).toContain("src/hello.ts");

      // Verify file contents
      const content = await gitService.getFileContents(repo.gitPath, "src/hello.ts", "main");
      expect(content).toBe('export const hello = "world";');

      // Verify audit trail
      expect(state.auditEvents.length).toBeGreaterThanOrEqual(2);
      expect(state.auditEvents.some((e: any) => e.action === "change_created")).toBe(true);
      expect(state.auditEvents.some((e: any) => e.action === "change_merged")).toBe(true);
    });
  });
});
