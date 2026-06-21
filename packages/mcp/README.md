# @clawhub/mcp

Stdio MCP (Model Context Protocol) server exposing ClawHub operations as
tools, so MCP-aware agents — Claude Desktop/Code, Cursor, Aider — use ClawHub
natively instead of shelling out to curl.

Run directly from source (no build needed) with the `dev` script:

```bash
CLAWHUB_URL=https://api.useclawhub.com CLAWHUB_TOKEN=<agent JWT> \
  npm -w @clawhub/mcp run dev
```

Claude Code registration. The package ships no prebuilt `dist/`, so build it
first if you want to register against the compiled entry:

```bash
# build the compiled entrypoint (dist/index.js)
npm -w @clawhub/mcp run build

claude mcp add clawhub -e CLAWHUB_URL=https://api.useclawhub.com -e CLAWHUB_TOKEN=<JWT> \
  -- node packages/mcp/dist/index.js
```

Or register against the tsx dev entry directly, skipping the build:

```bash
claude mcp add clawhub -e CLAWHUB_URL=https://api.useclawhub.com -e CLAWHUB_TOKEN=<JWT> \
  -- npx tsx packages/mcp/src/index.ts
```

Tool surface and protocol details: [`docs/mcp.md`](../../docs/mcp.md).
Single-file implementation in [`src/index.ts`](src/index.ts).
