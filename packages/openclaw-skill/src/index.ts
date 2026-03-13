#!/usr/bin/env node

import { ClawForgeClient } from "./client.js";
import { createTools } from "./tools.js";
import type { ToolResult } from "./tools.js";

export { ClawForgeClient, ClawForgeError } from "./client.js";
export { createTools } from "./tools.js";
export type {
  FileChange,
  SubmitChangeParams,
  RepoInfo,
  ChangeInfo,
  AgentRegistration,
} from "./client.js";
export type {
  ToolResult,
  CreateRepoParams,
  PushParams,
  StatusParams,
  BrowseParams,
  ToolHandlers,
} from "./tools.js";

/**
 * Initialize the ClawForge skill from environment variables.
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
      name: "clawforge_create_repo",
      description: "Create a new repository on ClawForge",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Repository name" },
          description: {
            type: "string",
            description: "Repository description",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "clawforge_push",
      description:
        "Submit a code change with intent to a ClawForge repository",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo_id: { type: "string", description: "Repository ID" },
          intent: {
            type: "string",
            description: "What this change does and why",
          },
          branch: {
            type: "string",
            description: "Branch name for this change",
          },
          files: {
            type: "array",
            description:
              "Array of {path, action, content} objects. action is 'create', 'update', or 'delete'.",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path" },
                action: {
                  type: "string",
                  enum: ["create", "update", "delete"],
                  description: "File action",
                },
                content: {
                  type: "string",
                  description: "File content (required for create/update)",
                },
              },
              required: ["path", "action"],
            },
          },
          description: {
            type: "string",
            description: "Detailed description of the change",
          },
        },
        required: ["repo_id", "intent", "branch", "files"],
      },
    },
    {
      name: "clawforge_status",
      description: "Check the status of changes in a repository",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo_id: { type: "string", description: "Repository ID" },
          change_id: {
            type: "string",
            description: "Specific change ID (optional)",
          },
        },
        required: ["repo_id"],
      },
    },
    {
      name: "clawforge_list_repos",
      description: "List your repositories on ClawForge",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "clawforge_browse",
      description: "Browse files in a ClawForge repository",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo_id: { type: "string", description: "Repository ID" },
          path: {
            type: "string",
            description:
              "File path to read (optional, lists all files if omitted)",
          },
        },
        required: ["repo_id"],
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
    case "clawforge_create_repo":
      return tools.clawforge_create_repo({
        name: params.name as string,
        description: params.description as string | undefined,
      });
    case "clawforge_push":
      return tools.clawforge_push({
        repo_id: params.repo_id as string,
        intent: params.intent as string,
        branch: params.branch as string,
        files: params.files as Array<{
          path: string;
          action: "create" | "update" | "delete";
          content?: string;
        }>,
        description: params.description as string | undefined,
      });
    case "clawforge_status":
      return tools.clawforge_status({
        repo_id: params.repo_id as string,
        change_id: params.change_id as string | undefined,
      });
    case "clawforge_list_repos":
      return tools.clawforge_list_repos();
    case "clawforge_browse":
      return tools.clawforge_browse({
        repo_id: params.repo_id as string,
        path: params.path as string | undefined,
      });
    default:
      return {
        content: `Unknown tool: ${toolName}`,
        isError: true,
      };
  }
}

// --- CLI mode ---

function printUsage() {
  console.log(`Usage:
  npx @clawforge/openclaw-skill --register --api-url <url> --owner-id <uuid> --agent-name <name>
  npx @clawforge/openclaw-skill --list-tools
  npx @clawforge/openclaw-skill --call <tool-name> --params '<json>'

Options:
  --register       Register a new agent and get a token
  --api-url        ClawForge API URL (default: http://localhost:3000)
  --owner-id       Owner user ID (required for --register)
  --agent-name     Agent name (required for --register)
  --list-tools     List available tool definitions
  --call           Call a tool by name
  --params         JSON parameters for the tool call
  --help           Show this help message
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
    const ownerId = args["owner-id"] as string;
    const agentName = args["agent-name"] as string;

    if (!ownerId || typeof ownerId !== "string") {
      console.error("Error: --owner-id is required for registration.");
      process.exit(1);
    }
    if (!agentName || typeof agentName !== "string") {
      console.error(
        "Error: --agent-name is required for registration.",
      );
      process.exit(1);
    }

    try {
      const result = await ClawForgeClient.registerAgent(
        apiUrl,
        ownerId,
        agentName,
      );
      console.log("Agent registered successfully!\n");
      console.log(`Agent ID: ${result.agent.id}`);
      console.log(`Agent Name: ${result.agent.name}`);
      console.log(`Token: ${result.token}`);
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
