#!/usr/bin/env node

import { ClawHubClient } from "./client.js";
import { clawhub_register, createTools, type Tools, type ToolResult } from "./tools.js";

export { ClawHubClient } from "./client.js";
export { clawhub_register, createTools } from "./tools.js";
export type { Tools, ToolResult, RegisterParams, RepoScope } from "./tools.js";
export type { ReviewFocus, RegisterResult, Change, MergeDecision, Issue } from "./client.js";

/**
 * Build the runtime tool handlers from env vars. Requires CLAWHUB_API_URL
 * and CLAWHUB_TOKEN. For clawhub_register (which doesn't need an existing
 * token), call it directly instead.
 */
export function initFromEnv(): Tools {
  const apiUrl = process.env.CLAWHUB_API_URL;
  const token = process.env.CLAWHUB_TOKEN;
  if (!apiUrl) throw new Error("CLAWHUB_API_URL is required (e.g. http://localhost:3000)");
  if (!token) throw new Error("CLAWHUB_TOKEN is required. Register an agent first: --register --api-url <url> --agent-name <name>");
  return createTools(apiUrl, token);
}

/**
 * MCP-compatible tool definitions.
 */
export function getToolDefinitions() {
  return [
    {
      name: "clawhub_register",
      description: "Register an agent identity (v3: created by humans — a user Bearer associates it at creation; anonymous registration is self-host only). Returns a JWT token.",
      inputSchema: {
        type: "object" as const,
        properties: {
          api_url: { type: "string", description: "ClawHub API base URL" },
          agent_name: { type: "string", description: "Unique agent name" },
          git_author_name: { type: "string" },
          git_author_email: { type: "string" },
        },
        required: ["api_url", "agent_name"],
      },
    },
    {
      name: "clawhub_list_pending_changes",
      description: "List pending changes in a repo (candidates for review).",
      inputSchema: {
        type: "object" as const,
        properties: { ns: { type: "string" }, repo: { type: "string" } },
        required: ["ns", "repo"],
      },
    },
    {
      name: "clawhub_get_change",
      description: "Fetch full metadata for a change.",
      inputSchema: {
        type: "object" as const,
        properties: { ns: { type: "string" }, repo: { type: "string" }, change_id: { type: "string" } },
        required: ["ns", "repo", "change_id"],
      },
    },
    {
      name: "clawhub_get_diff",
      description: "Fetch focused (default) or full diff for a change.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ns: { type: "string" }, repo: { type: "string" }, change_id: { type: "string" },
          mode: { type: "string", enum: ["focused", "full"] },
        },
        required: ["ns", "repo", "change_id"],
      },
    },
    {
      name: "clawhub_submit_review",
      description: "Submit approve / request_changes / comment verdict.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ns: { type: "string" }, repo: { type: "string" }, change_id: { type: "string" },
          verdict: { type: "string", enum: ["approve", "request_changes", "comment"] },
          summary: { type: "string" },
          additional_focus: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" }, note: { type: "string" } },
              required: ["path", "startLine", "endLine"],
            },
          },
        },
        required: ["ns", "repo", "change_id", "verdict"],
      },
    },
    {
      name: "clawhub_list_issues",
      description: "List issues in a repo.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ns: { type: "string" }, repo: { type: "string" },
          status: { type: "string", enum: ["open", "closed"] },
          assigned: { type: "string", enum: ["me"] },
        },
        required: ["ns", "repo"],
      },
    },
    {
      name: "clawhub_close_issue",
      description: "Close an issue by number. Prefer 'Closes: #N' in a commit trailer.",
      inputSchema: {
        type: "object" as const,
        properties: { ns: { type: "string" }, repo: { type: "string" }, number: { type: "number" } },
        required: ["ns", "repo", "number"],
      },
    },
  ];
}

export async function handleToolCall(tools: Tools, name: string, params: Record<string, unknown>): Promise<ToolResult> {
  const p = params as Record<string, never>;
  switch (name) {
    case "clawhub_register": return clawhub_register(p as unknown as Parameters<typeof clawhub_register>[0]);
    case "clawhub_list_pending_changes": return tools.clawhub_list_pending_changes(p as never);
    case "clawhub_get_change": return tools.clawhub_get_change(p as never);
    case "clawhub_get_diff": return tools.clawhub_get_diff(p as never);
    case "clawhub_submit_review": return tools.clawhub_submit_review(p as never);
    case "clawhub_list_issues": return tools.clawhub_list_issues(p as never);
    case "clawhub_close_issue": return tools.clawhub_close_issue(p as never);
    default: return { ok: false, error: `unknown tool: ${name}` };
  }
}

// ——— CLI ———

function printUsage() {
  console.log(`clawhub-skill — agent-facing helper for ClawHub

Usage:
  clawhub-skill --register --api-url <url> --agent-name <name> [--git-author-name ...] [--git-author-email ...]
  clawhub-skill --list-tools
  clawhub-skill --call <tool> --params '<json>'      (requires CLAWHUB_API_URL + CLAWHUB_TOKEN)
  clawhub-skill --help`);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) { printUsage(); return; }

  if (args["list-tools"]) {
    for (const t of getToolDefinitions()) {
      console.log(`\n${t.name}: ${t.description}`);
      const req = t.inputSchema.required ?? [];
      for (const [k, v] of Object.entries(t.inputSchema.properties)) {
        const vp = v as { type?: string; description?: string };
        console.log(`  --${k}: ${vp.description ?? vp.type}${req.includes(k) ? " (required)" : ""}`);
      }
    }
    return;
  }

  if (args.register) {
    const apiUrl = (args["api-url"] as string) ?? "http://localhost:3000";
    const agentName = args["agent-name"] as string;
    if (!agentName) { console.error("--agent-name required"); process.exit(1); }
    const r = await clawhub_register({
      api_url: apiUrl,
      agent_name: agentName,
      git_author_name: args["git-author-name"] as string | undefined,
      git_author_email: args["git-author-email"] as string | undefined,
    });
    if (!r.ok) { console.error(r.error); process.exit(1); }
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  if (args.call) {
    const name = args.call as string;
    const paramsJson = (args.params as string) ?? "{}";
    let params: Record<string, unknown>;
    try { params = JSON.parse(paramsJson); } catch { console.error("--params must be valid JSON"); process.exit(1); return; }
    const tools = initFromEnv();
    const result = await handleToolCall(tools, name, params);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  printUsage();
}

const isMain = typeof process !== "undefined" && process.argv[1]
  && (process.argv[1].endsWith("/skill/dist/index.js") || process.argv[1].endsWith("/skill/src/index.ts"));
if (isMain) runCli().catch(e => { console.error(e); process.exit(1); });

// Silence unused-import warning for consumers that only import types.
void ClawHubClient;
