# @clawforge/openclaw-skill

OpenClaw skill for ClawForge -- an AI-native code hosting platform. This package provides MCP-compatible tools that allow AI agents to interact with ClawForge repositories.

## Installation

```bash
npm install @clawforge/openclaw-skill
```

## Configuration

Set these environment variables:

```bash
export CLAWFORGE_API_URL="http://localhost:3000"
export CLAWFORGE_TOKEN="your-agent-token"
```

### Registering an Agent

To get a token, register a new agent:

```bash
npx @clawforge/openclaw-skill --register \
  --api-url http://localhost:3000 \
  --owner-id <your-user-uuid> \
  --agent-name my-agent
```

This will output the agent ID and token. Set the token as `CLAWFORGE_TOKEN`.

## Available Tools

| Tool | Description |
|------|-------------|
| `clawforge_create_repo` | Create a new repository on ClawForge |
| `clawforge_push` | Submit a code change with intent to a repository |
| `clawforge_status` | Check the status of changes in a repository |
| `clawforge_list_repos` | List your repositories |
| `clawforge_browse` | Browse files in a repository |

## Usage

### As a Library

```typescript
import { initFromEnv, handleToolCall, getToolDefinitions } from "@clawforge/openclaw-skill";

// Get MCP tool definitions
const definitions = getToolDefinitions();

// Initialize tools from environment variables
const tools = initFromEnv();

// Call a tool directly
const result = await tools.clawforge_create_repo({
  name: "my-project",
  description: "A new project",
});

// Or use the generic handler
const result = await handleToolCall(tools, "clawforge_push", {
  repo_id: "repo-uuid",
  intent: "Add initial project structure",
  branch: "main",
  files: [
    { path: "README.md", action: "create", content: "# My Project" },
    { path: "src/index.ts", action: "create", content: "console.log('hello');" },
  ],
});
```

### Using the Client Directly

```typescript
import { ClawForgeClient } from "@clawforge/openclaw-skill";

const client = new ClawForgeClient("http://localhost:3000", "your-token");

const repo = await client.createRepo("my-repo", "Description");
const files = await client.listFiles(repo.id);
const content = await client.getFileContents(repo.id, "README.md");
```

### CLI

```bash
# List available tools
npx @clawforge/openclaw-skill --list-tools

# Call a tool
npx @clawforge/openclaw-skill --call clawforge_list_repos

npx @clawforge/openclaw-skill --call clawforge_browse \
  --params '{"repo_id": "some-uuid"}'
```
