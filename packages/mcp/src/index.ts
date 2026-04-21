#!/usr/bin/env node
/**
 * ClawHub MCP server — stdio JSON-RPC 2.0 implementation of the Model Context
 * Protocol, exposing ClawHub operations as tools and resources so any MCP-aware
 * agent (Claude Desktop, Cursor, Aider, etc.) can use ClawHub natively.
 *
 * Env:
 *   CLAWHUB_URL   — base URL, default http://localhost:3000
 *   CLAWHUB_TOKEN — agent or user JWT
 */

import { createInterface } from "node:readline";

const BASE = (process.env.CLAWHUB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.CLAWHUB_TOKEN ?? "";

type JsonRpcReq = { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown };
type JsonRpcResp = { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<unknown>;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`clawhub_${res.status}: ${typeof data === "object" ? JSON.stringify(data) : text}`);
  return data as T;
}

const TOOLS: ToolDef[] = [
  {
    name: "clawhub_list_repos",
    description: "List repositories the caller has access to.",
    inputSchema: { type: "object", properties: {} },
    async call() { return request("GET", "/api/v1/repos"); },
  },
  {
    name: "clawhub_get_repo",
    description: "Get a repo by namespace and name.",
    inputSchema: { type: "object", required: ["ns", "repo"], properties: { ns: { type: "string" }, repo: { type: "string" } } },
    async call(a) { return request("GET", `/api/v1/repos/${encodeURIComponent(a.ns as string)}/${encodeURIComponent(a.repo as string)}`); },
  },
  {
    name: "clawhub_list_changes",
    description: "List Changes (PR equivalents) in a repo.",
    inputSchema: { type: "object", required: ["ns", "repo"], properties: { ns: { type: "string" }, repo: { type: "string" } } },
    async call(a) { return request("GET", `/api/v1/repos/${encodeURIComponent(a.ns as string)}/${encodeURIComponent(a.repo as string)}/changes`); },
  },
  {
    name: "clawhub_get_change",
    description: "Get a Change by id.",
    inputSchema: { type: "object", required: ["ns", "repo", "id"], properties: { ns: { type: "string" }, repo: { type: "string" }, id: { type: "string" } } },
    async call(a) { return request("GET", `/api/v1/repos/${a.ns}/${a.repo}/changes/${a.id}`); },
  },
  {
    name: "clawhub_get_focused_diff",
    description: "Get the focused diff for a Change (only lines flagged by the agent).",
    inputSchema: { type: "object", required: ["ns", "repo", "id"], properties: { ns: { type: "string" }, repo: { type: "string" }, id: { type: "string" }, mode: { type: "string", enum: ["focused", "full"], default: "focused" } } },
    async call(a) { return request("GET", `/api/v1/repos/${a.ns}/${a.repo}/changes/${a.id}/diff?mode=${a.mode ?? "focused"}`); },
  },
  {
    name: "clawhub_submit_review",
    description: "Submit a review verdict (approve/request_changes/comment) for a Change.",
    inputSchema: { type: "object", required: ["ns", "repo", "id", "verdict"], properties: { ns: { type: "string" }, repo: { type: "string" }, id: { type: "string" }, verdict: { type: "string", enum: ["approve", "request_changes", "comment"] }, summary: { type: "string" } } },
    async call(a) { return request("POST", `/api/v1/repos/${a.ns}/${a.repo}/changes/${a.id}/reviews`, { verdict: a.verdict, summary: a.summary }); },
  },
  {
    name: "clawhub_add_comment",
    description: "Add an inline review comment on a Change, optionally starting a thread at path:line.",
    inputSchema: { type: "object", required: ["ns", "repo", "id", "body"], properties: { ns: { type: "string" }, repo: { type: "string" }, id: { type: "string" }, path: { type: "string" }, line: { type: "number" }, threadId: { type: "string" }, body: { type: "string" }, suggestion: { type: "string" } } },
    async call(a) { return request("POST", `/api/v1/repos/${a.ns}/${a.repo}/changes/${a.id}/comments`, a); },
  },
  {
    name: "clawhub_list_issues",
    description: "List issues in a repo. Filter with status=open|closed or assigned=me.",
    inputSchema: { type: "object", required: ["ns", "repo"], properties: { ns: { type: "string" }, repo: { type: "string" }, status: { type: "string", enum: ["open", "closed"] }, assigned: { type: "string", enum: ["me"] } } },
    async call(a) {
      const q = new URLSearchParams();
      if (a.status) q.set("status", String(a.status));
      if (a.assigned) q.set("assigned", String(a.assigned));
      return request("GET", `/api/v1/repos/${a.ns}/${a.repo}/issues${q.size ? "?" + q : ""}`);
    },
  },
  {
    name: "clawhub_create_issue",
    description: "Create an issue in a repo.",
    inputSchema: { type: "object", required: ["ns", "repo", "title"], properties: { ns: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } }, priority: { type: "string", enum: ["low","normal","high","urgent"] } } },
    async call(a) { return request("POST", `/api/v1/repos/${a.ns}/${a.repo}/issues`, a); },
  },
  {
    name: "clawhub_search",
    description: "Search repos, issues, changes, agents, and code.",
    inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, publicOnly: { type: "boolean" } } },
    async call(a) {
      const q = new URLSearchParams({ q: String(a.q) });
      if (a.publicOnly) q.set("public", "1");
      return request("GET", `/api/v1/search?${q}`);
    },
  },
  {
    name: "clawhub_record_cost",
    description: "Record token + $ cost for a change (by the calling agent). Used for budget tracking.",
    inputSchema: { type: "object", properties: { changeId: { type: "string" }, repoId: { type: "string" }, inputTokens: { type: "number" }, outputTokens: { type: "number" }, cachedTokens: { type: "number" }, costCents: { type: "number" }, model: { type: "string" }, kind: { type: "string" } } },
    async call(a) { return request("POST", `/api/v1/cost/self`, a); },
  },
  {
    name: "clawhub_record_attestation",
    description: "Record a signed provenance attestation for a commit this agent authored.",
    inputSchema: { type: "object", required: ["repoId", "commitSha"], properties: { repoId: { type: "string" }, changeId: { type: "string" }, commitSha: { type: "string" }, agentVersion: { type: "string" }, modelName: { type: "string" }, modelVersion: { type: "string" }, promptHash: { type: "string" }, framework: { type: "string" }, toolsUsed: { type: "array", items: { type: "string" } }, testsRun: { type: "boolean" }, typechecked: { type: "boolean" }, extra: { type: "object" } } },
    async call(a) { return request("POST", `/api/v1/attestations`, a); },
  },
  {
    name: "clawhub_sandbox_launch",
    description: "Launch a sandboxed exec for this agent, tied to a repo. Returns the sandbox id; poll with clawhub_sandbox_get.",
    inputSchema: { type: "object", required: ["repoId", "command"], properties: { repoId: { type: "string" }, ref: { type: "string" }, image: { type: "string" }, command: { type: "string" }, timeoutMs: { type: "number" } } },
    async call(a) { return request("POST", `/api/v1/sandbox`, a); },
  },
  {
    name: "clawhub_sandbox_get",
    description: "Fetch the status + stdout/stderr of a sandbox run.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    async call(a) { return request("GET", `/api/v1/sandbox/${a.id}`); },
  },
  {
    name: "clawhub_inbox",
    description: "Read the calling agent's inbox of a2a messages (feedback, handoffs, task assignments).",
    inputSchema: { type: "object", properties: { unreadOnly: { type: "boolean" } } },
    async call(a) { return request("GET", `/api/v1/agents/inbox${a.unreadOnly ? "?unread=1" : ""}`); },
  },
  {
    name: "clawhub_send_agent_message",
    description: "Send a structured message to another agent's inbox (feedback / handoff / task).",
    inputSchema: { type: "object", required: ["toAgentId", "body"], properties: { toAgentId: { type: "string" }, changeId: { type: "string" }, kind: { type: "string", enum: ["feedback", "review_request", "handoff", "task", "context"] }, body: { type: "object" } } },
    async call(a) { return request("POST", `/api/v1/agents/messages`, a); },
  },
  {
    name: "clawhub_evaluate_flag",
    description: "Evaluate a feature flag for a given user/agent context.",
    inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" }, repoId: { type: "string" }, context: { type: "object" } } },
    async call(a) { return request("POST", `/api/v1/flags/evaluate`, a); },
  },
];

function ok(id: JsonRpcReq["id"], result: unknown): JsonRpcResp { return { jsonrpc: "2.0", id: id ?? null, result }; }
function err(id: JsonRpcReq["id"], code: number, message: string, data?: unknown): JsonRpcResp {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

async function handle(msg: JsonRpcReq): Promise<JsonRpcResp | null> {
  if (msg.method === "initialize") {
    return ok(msg.id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "clawhub-mcp", version: "0.1.0" },
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: {} },
    });
  }
  if (msg.method === "notifications/initialized") return null;
  if (msg.method === "tools/list") {
    return ok(msg.id, { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (msg.method === "tools/call") {
    const p = (msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined) ?? {};
    const tool = TOOLS.find(t => t.name === p.name);
    if (!tool) return err(msg.id, -32601, `unknown tool: ${p.name}`);
    try {
      const result = await tool.call(p.arguments ?? {});
      return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return err(msg.id, -32000, (e as Error).message ?? String(e));
    }
  }
  if (msg.method === "resources/list") return ok(msg.id, { resources: [] });
  if (msg.method === "prompts/list") return ok(msg.id, { prompts: [] });
  if (msg.method === "ping") return ok(msg.id, {});
  return err(msg.id, -32601, `method not found: ${msg.method}`);
}

async function main() {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async line => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcReq;
      const resp = await handle(msg);
      if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
    } catch (e) {
      process.stderr.write(`[clawhub-mcp] parse error: ${(e as Error).message}\n`);
    }
  });
  rl.on("close", () => process.exit(0));
}

void main();
