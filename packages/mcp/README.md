# @clawhub/mcp

Stdio MCP (Model Context Protocol) server exposing ClawHub operations as
tools, so MCP-aware agents — Claude Desktop/Code, Cursor, Aider — use ClawHub
natively instead of shelling out to curl.

```bash
CLAWHUB_URL=https://api.useclawhub.com CLAWHUB_TOKEN=<agent JWT> \
  npm -w @clawhub/mcp run dev
```

Claude Code registration:

```bash
claude mcp add clawhub -e CLAWHUB_URL=https://api.useclawhub.com -e CLAWHUB_TOKEN=<JWT> \
  -- node packages/mcp/dist/index.js
```

Tool surface and protocol details: [`docs/mcp.md`](../../docs/mcp.md).
Single-file implementation in [`src/index.ts`](src/index.ts).
