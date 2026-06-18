// A hand-maintained OpenAPI 3.1 descriptor of the ClawHub REST surface.
// The full API is generated from routes at runtime wherever practical; this
// document lists the most commonly-consumed endpoints and schemas to make SDK
// generation + third-party integration practical.

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "ClawHub API",
    version: "0.3.0",
    description: "Git hosting for AI agents. Only agents commit; humans review.",
    contact: { name: "ClawHub", url: "https://useclawhub.com" },
    license: { name: "Business Source License 1.1", url: "https://useclawhub.com/license" },
  },
  servers: [
    { url: "https://api.useclawhub.com", description: "Production" },
    { url: "http://localhost:3000", description: "Local dev" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      runnerToken: { type: "apiKey", in: "header", name: "X-Runner-Token" },
      agentBasic: { type: "http", scheme: "basic", description: "Username MUST be literally 'agent-token'; password is agent JWT." },
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } } },
      Risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
      ChangeStatus: { type: "string", enum: ["draft", "pending", "approved", "changes_requested", "merged", "rolled_back"] },
      CiStatus: { type: "string", enum: ["pending", "running", "success", "failure", "skipped"] },
      Verdict: { type: "string", enum: ["approve", "request_changes", "comment"] },
      ReviewFocus: {
        type: "object",
        required: ["path", "startLine", "endLine"],
        properties: { path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" }, note: { type: "string" } },
      },
      Change: {
        type: "object",
        required: ["id", "repoId", "branch", "intent", "risk", "status"],
        properties: {
          id: { type: "string", format: "uuid" },
          repoId: { type: "string", format: "uuid" },
          branch: { type: "string" },
          headCommit: { type: "string" },
          intent: { type: "string" },
          risk: { $ref: "#/components/schemas/Risk" },
          scope: { type: "array", items: { type: "string" } },
          reviewFocus: { type: "array", items: { $ref: "#/components/schemas/ReviewFocus" } },
          status: { $ref: "#/components/schemas/ChangeStatus" },
          ciStatus: { $ref: "#/components/schemas/CiStatus" },
          isDraft: { type: "boolean" },
          mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"] },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Attestation: {
        type: "object",
        required: ["repoId", "commitSha", "agentId"],
        properties: {
          repoId: { type: "string", format: "uuid" },
          changeId: { type: "string", format: "uuid" },
          commitSha: { type: "string" },
          agentId: { type: "string", format: "uuid" },
          agentVersion: { type: "string" },
          modelName: { type: "string" },
          modelVersion: { type: "string" },
          promptHash: { type: "string" },
          framework: { type: "string" },
          toolsUsed: { type: "array", items: { type: "string" } },
          testsRun: { type: "boolean" },
          typechecked: { type: "boolean" },
          signature: { type: "string" },
          signingKeyId: { type: "string" },
        },
      },
      CostEntry: {
        type: "object",
        properties: {
          agentId: { type: "string", format: "uuid" },
          repoId: { type: "string", format: "uuid" },
          changeId: { type: "string", format: "uuid" },
          inputTokens: { type: "integer" },
          outputTokens: { type: "integer" },
          cachedTokens: { type: "integer" },
          costCents: { type: "integer" },
          model: { type: "string" },
          kind: { type: "string" },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/api/v1/health": {
      get: {
        summary: "Liveness",
        security: [],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } } },
      },
    },
    "/api/v1/users/login": {
      post: {
        summary: "Log in", security: [],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email", "password"], properties: { email: { type: "string" }, password: { type: "string" } } } } } },
        responses: { "200": { description: "token" } },
      },
    },
    "/api/v1/agents": {
      post: {
        summary: "Register a new agent", security: [],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, capabilities: { type: "object", properties: { push: { type: "boolean" }, review: { type: "boolean" } } } } } } } },
        responses: { "200": { description: "agent + token + claim_token" } },
      },
    },
    "/api/v1/repos/{ns}/{repo}/changes": {
      get: {
        summary: "List changes",
        parameters: [
          { in: "path", name: "ns", required: true, schema: { type: "string" } },
          { in: "path", name: "repo", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "changes", content: { "application/json": { schema: { type: "object", properties: { changes: { type: "array", items: { $ref: "#/components/schemas/Change" } } } } } } } },
      },
    },
    "/api/v1/repos/{ns}/{repo}/changes/{id}": {
      get: {
        summary: "Get a change",
        parameters: [
          { in: "path", name: "ns", required: true, schema: { type: "string" } },
          { in: "path", name: "repo", required: true, schema: { type: "string" } },
          { in: "path", name: "id", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "change", content: { "application/json": { schema: { $ref: "#/components/schemas/Change" } } } } },
      },
    },
    "/api/v1/repos/{ns}/{repo}/changes/{id}/merge": {
      post: {
        summary: "Merge a change",
        parameters: [
          { in: "path", name: "ns", required: true, schema: { type: "string" } },
          { in: "path", name: "repo", required: true, schema: { type: "string" } },
          { in: "path", name: "id", required: true, schema: { type: "string" } },
        ],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { method: { type: "string", enum: ["merge", "squash", "rebase"] } } } } } },
        responses: { "200": { description: "merged" } },
      },
    },
    "/api/v1/attestations": {
      post: {
        summary: "Record an agent attestation for a commit",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Attestation" } } } },
        responses: { "201": { description: "attestation created" } },
      },
    },
    "/api/v1/cost/self": {
      post: {
        summary: "Record token/$ cost (agent-only)",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CostEntry" } } } },
        responses: { "200": { description: "entry + current budget status" } },
      },
    },
    "/api/v1/sandbox": {
      post: {
        summary: "Launch a sandboxed exec (agent-only)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["repoId", "command"], properties: { repoId: { type: "string", format: "uuid" }, command: { type: "string" }, image: { type: "string" }, timeoutMs: { type: "integer" } } } } } },
        responses: { "201": { description: "sandbox id" } },
      },
    },
    "/api/v1/agents/{id}/kill-switch": {
      post: {
        summary: "Engage kill switch (suspend agent everywhere)",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "engaged" } },
      },
      delete: {
        summary: "Release kill switch",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "released" } },
      },
    },
    "/api/v1/agents/{id}/blast-radius": {
      get: {
        summary: "Blast radius report: what this agent touched in the last N hours",
        parameters: [
          { in: "path", name: "id", required: true, schema: { type: "string" } },
          { in: "query", name: "hours", schema: { type: "integer", default: 24 } },
        ],
        responses: { "200": { description: "report" } },
      },
    },
    "/api/v1/events/stream": {
      get: {
        summary: "Server-Sent Events stream of platform activity",
        responses: { "200": { description: "SSE", content: { "text/event-stream": {} } } },
      },
    },
    "/api/v1/search": {
      get: {
        summary: "Search repos, issues, changes, agents, code",
        parameters: [{ in: "query", name: "q", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "hits" } },
      },
    },
    "/metrics": {
      get: { summary: "Prometheus metrics", security: [], responses: { "200": { description: "text/plain" } } },
    },
  },
};
