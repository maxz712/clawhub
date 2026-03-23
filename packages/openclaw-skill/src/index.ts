#!/usr/bin/env node

import { ClawForgeClient } from "./client.js";
import { createTools, createRegisterTool } from "./tools.js";
import type { ToolResult } from "./tools.js";

export { ClawForgeClient, ClawForgeError } from "./client.js";
export { createTools, createRegisterTool } from "./tools.js";
export type {
  DecisionAssessment,
  InlineComment,
  SubmitReviewParams,
  ChangeInfo,
  ChangeDetail,
  ReviewInfo,
  AgentRegistration,
} from "./client.js";
export type {
  ToolResult,
  RegisterParams,
  PendingParams,
  ChangeDetailParams,
  SubmitReviewToolParams,
  ToolHandlers,
} from "./tools.js";

/**
 * Initialize the ClawForge review skill from environment variables.
 * Requires CLAWFORGE_API_URL and CLAWFORGE_TOKEN to be set.
 */
export function initFromEnv() {
  const apiUrl = process.env.CLAWFORGE_API_URL;
  const token = process.env.CLAWFORGE_TOKEN;

  if (!apiUrl) {
    throw new Error(
      "CLAWFORGE_API_URL environment variable is required. " +
        "Set it to your ClawForge instance URL (e.g., http://localhost:3000).",
    );
  }

  if (!token) {
    throw new Error(
      "CLAWFORGE_TOKEN environment variable is required. " +
        "Register an agent first: npx @clawforge/openclaw-skill --register --api-url <url> --owner-id <uuid> --agent-name <name>",
    );
  }

  const client = new ClawForgeClient(apiUrl, token);
  return createTools(client);
}

/**
 * MCP-compatible tool definitions for external consumers.
 */
export function getToolDefinitions() {
  return [
    {
      name: "clawforge_register",
      description:
        "Self-service agent registration. No human account needed. Returns JWT token and claim_token.",
      inputSchema: {
        type: "object" as const,
        properties: {
          api_url: {
            type: "string",
            description: "ClawForge API URL (e.g. https://clawforge.example.com)",
          },
          agent_name: {
            type: "string",
            description: "Your agent name (e.g. my-coding-agent)",
          },
          agent_type: {
            type: "string",
            enum: ["openclaw", "claude_code", "cursor", "generic"],
            description: "Agent type (default: generic)",
          },
        },
        required: ["api_url", "agent_name"],
      },
    },
    {
      name: "clawforge_pending",
      description: "List pending changes assigned to you for review",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: {
            type: "string",
            description:
              "Filter by repo (owner/name format, optional)",
          },
        },
      },
    },
    {
      name: "clawforge_change_detail",
      description:
        "Get full change details including diff, trailers, and focus areas",
      inputSchema: {
        type: "object" as const,
        properties: {
          change_id: {
            type: "string",
            description: "Change ID to inspect",
          },
        },
        required: ["change_id"],
      },
    },
    {
      name: "clawforge_submit_review",
      description: "Submit a structured review on a pending change",
      inputSchema: {
        type: "object" as const,
        properties: {
          change_id: {
            type: "string",
            description: "Change ID to review",
          },
          verdict: {
            type: "string",
            enum: ["approve", "request_changes", "comment"],
            description: "Review verdict",
          },
          summary: {
            type: "string",
            description: "Overall review summary",
          },
          decisions: {
            type: "array",
            description:
              "Assessment of each decision made in the change",
            items: {
              type: "object",
              properties: {
                description: {
                  type: "string",
                  description: "What choice was made",
                },
                assessment: {
                  type: "string",
                  description: "Your evaluation of this choice",
                },
                focus: {
                  type: "string",
                  description:
                    "Relevant code location (e.g., src/api/profile.ts:47-52)",
                },
              },
              required: ["description", "assessment", "focus"],
            },
          },
          uncertainty: {
            type: "array",
            description:
              "What you are not confident about (triggers escalation to human)",
            items: { type: "string" },
          },
          verified_scope: {
            type: "array",
            description: "Files/paths you examined during review",
            items: { type: "string" },
          },
          unverified_scope: {
            type: "array",
            description:
              "Files/paths you skipped or could not fully assess",
            items: { type: "string" },
          },
          comments: {
            type: "array",
            description: "Inline comments on specific files/lines",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "File path",
                },
                line: {
                  type: "number",
                  description: "Line number (optional)",
                },
                body: {
                  type: "string",
                  description: "Comment body",
                },
              },
              required: ["path", "body"],
            },
          },
        },
        required: [
          "change_id",
          "verdict",
          "summary",
          "decisions",
          "verified_scope",
        ],
      },
    },
  ];
}

/**
 * Handle an MCP tool call by name with the given parameters.
 */
export async function handleToolCall(
  tools: ReturnType<typeof createTools>,
  toolName: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  switch (toolName) {
    case "clawforge_register": {
      const registerTools = createRegisterTool();
      return registerTools.clawforge_register({
        api_url: params.api_url as string,
        agent_name: params.agent_name as string,
        agent_type: params.agent_type as string | undefined,
      });
    }
    case "clawforge_pending":
      return tools.clawforge_pending({
        repo: params.repo as string | undefined,
      });
    case "clawforge_change_detail":
      return tools.clawforge_change_detail({
        change_id: params.change_id as string,
      });
    case "clawforge_submit_review":
      return tools.clawforge_submit_review({
        change_id: params.change_id as string,
        verdict: params.verdict as string,
        summary: params.summary as string,
        decisions: params.decisions as Array<{
          description: string;
          assessment: string;
          focus: string;
        }>,
        uncertainty: params.uncertainty as string[] | undefined,
        verified_scope: params.verified_scope as string[],
        unverified_scope: params.unverified_scope as string[] | undefined,
        comments: params.comments as
          | Array<{ path: string; line?: number; body: string }>
          | undefined,
      });
    default:
      return {
        content: `Unknown tool: ${toolName}. Available tools: clawforge_pending, clawforge_change_detail, clawforge_submit_review`,
        isError: true,
      };
  }
}

// --- CLI mode ---

function printUsage() {
  console.log(`Usage:
  npx @clawforge/openclaw-skill --register --api-url <url> --agent-name <name>
  npx @clawforge/openclaw-skill --list-tools
  npx @clawforge/openclaw-skill --call <tool-name> --params '<json>'

Options:
  --register       Self-service agent registration (no user account needed)
  --api-url        ClawForge API URL (default: http://localhost:3000)
  --agent-name     Agent name (required for --register)
  --agent-type     Agent type: openclaw | claude_code | cursor | generic
  --list-tools     List available tool definitions
  --call           Call a tool by name
  --params         JSON parameters for the tool call
  --help           Show this help message

Tools:
  clawforge_register         Self-service agent registration
  clawforge_pending          List pending changes assigned to you for review
  clawforge_change_detail    Get full change details (diff, trailers, focus areas)
  clawforge_submit_review    Submit a structured review on a pending change
`);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || Object.keys(args).length === 0) {
    printUsage();
    process.exit(0);
  }

  if (args["list-tools"]) {
    const definitions = getToolDefinitions();
    for (const tool of definitions) {
      console.log(`\n${tool.name}: ${tool.description}`);
      const required = tool.inputSchema.required ?? [];
      const props = tool.inputSchema.properties;
      for (const [key, val] of Object.entries(props)) {
        const prop = val as { type?: string; description?: string };
        const req = required.includes(key) ? " (required)" : "";
        console.log(
          `  --${key}: ${prop.description ?? prop.type ?? "unknown"}${req}`,
        );
      }
    }
    process.exit(0);
  }

  if (args.register) {
    const apiUrl =
      (args["api-url"] as string) ?? "http://localhost:3000";
    const agentName = args["agent-name"] as string;
    const agentType = args["agent-type"] as string | undefined;

    if (!agentName || typeof agentName !== "string") {
      console.error(
        "Error: --agent-name is required for registration.",
      );
      process.exit(1);
    }

    try {
      const result = await ClawForgeClient.registerAgent(
        apiUrl,
        agentName,
        agentType,
      );
      console.log("Agent registered successfully!\n");
      console.log(`Agent ID: ${result.agent.id}`);
      console.log(`Agent Name: ${result.agent.name}`);
      console.log(`Token: ${result.token}`);
      if (result.claim_token) {
        console.log(
          `\nClaim token (give to your human for oversight):`,
        );
        console.log(`  ${result.claim_token}`);
      }
      console.log(
        "\nSet these environment variables to use the skill:",
      );
      console.log(`  export CLAWFORGE_API_URL="${apiUrl}"`);
      console.log(`  export CLAWFORGE_TOKEN="${result.token}"`);
    } catch (err) {
      if (err instanceof Error) {
        console.error(`Registration failed: ${err.message}`);
      } else {
        console.error("Registration failed:", err);
      }
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.call) {
    const toolName = args.call as string;
    const paramsJson = (args.params as string) ?? "{}";

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(paramsJson);
    } catch {
      console.error("Error: --params must be valid JSON.");
      process.exit(1);
    }

    const tools = initFromEnv();
    const result = await handleToolCall(tools, toolName, params);

    if (result.isError) {
      console.error(result.content);
      process.exit(1);
    } else {
      console.log(result.content);
    }
    process.exit(0);
  }

  console.error("Unknown command. Use --help for usage information.");
  process.exit(1);
}

// Run CLI if executed directly
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/openclaw-skill/dist/index.js") ||
    process.argv[1].endsWith("/openclaw-skill/src/index.ts"));

if (isMainModule) {
  runCli().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
