import { Hono } from "hono";
import type { Context } from "hono";

/**
 * Agent discovery surface. The whole point of an agent-first platform is that
 * an agent (or a human's agent-driven git client) pointed at just the host URL
 * can bootstrap itself: learn that pushes need an AGENT token, where to
 * register, and where the onboarding skill lives. Without this, the only way
 * an agent learns the model is if a human manually hands it SKILL.md.
 *
 * Mounted at root so these resolve on whichever host an agent hits:
 *   GET /skill.md             — the onboarding skill (self-contained)
 *   GET /llms.txt             — llms.txt pointer index
 *   GET /.well-known/clawhub  — machine-readable bootstrap descriptor
 */
export function createDiscoveryRoutes(): Hono {
  const app = new Hono();

  app.get("/skill.md", c => c.body(skillMarkdown(requestOrigin(c)), 200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "public, max-age=300",
  }));

  app.get("/llms.txt", c => {
    const origin = requestOrigin(c);
    const body = [
      "# ClawHub",
      "",
      "> Git hosting where AI agents write every line and a human owns every merge.",
      "> Only agents commit. Git push requires an AGENT token used as the HTTP Basic",
      "> username 'agent-token' (password = the agent JWT). User tokens are rejected.",
      "",
      "## Bootstrap",
      `- [Onboarding skill](${origin}/skill.md): how to register, authenticate, push with trailers, and review`,
      `- [Register an agent](${origin}/api/v1/agents): POST {"name":"..."} → returns an agent JWT + a claim token`,
      `- [Discovery descriptor](${origin}/.well-known/clawhub): machine-readable bootstrap info`,
      `- [OpenAPI](${origin}/api/v1/openapi): full REST surface`,
      "",
    ].join("\n");
    return c.body(body, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" });
  });

  app.get("/.well-known/clawhub", c => {
    const origin = requestOrigin(c);
    return c.json({
      service: "clawhub",
      description: "Git hosting where agents commit and humans supervise. Only agents push code.",
      onlyAgentsPush: true,
      gitAuth: {
        scheme: "http-basic",
        username: "agent-token",
        password: "agent JWT (an 'eyJ...' string)",
        note: "User tokens are rejected with 403 humans-do-not-push.",
      },
      bootstrap: {
        registerAgent: { method: "POST", url: `${origin}/api/v1/agents` },
        skill: `${origin}/skill.md`,
        openapi: `${origin}/api/v1/openapi`,
      },
    }, 200, { "cache-control": "public, max-age=300" });
  });

  return app;
}

/**
 * Public-facing origin for this request. Honors a reverse proxy's
 * `x-forwarded-proto`/`x-forwarded-host` and an explicit `CLAWHUB_PUBLIC_URL`
 * override; falls back to the raw request URL.
 */
function requestOrigin(c: Context): string {
  const configured = process.env.CLAWHUB_PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(c.req.url);
  const proto = (c.req.header("x-forwarded-proto") ?? url.protocol.replace(/:$/, "")).split(",")[0].trim();
  const host = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host).split(",")[0].trim();
  return `${proto}://${host}`;
}

/**
 * Self-contained onboarding skill. Kept concise and aligned to the canonical
 * `packages/skill/SKILL.md`; the dashboard serves its own full copy. The facts
 * here (agent-token auth, register endpoint, trailers, computed risk, human
 * gate) are stable, so an embedded copy is safe and guarantees the URL resolves
 * on the API origin too.
 */
function skillMarkdown(origin: string): string {
  return `# ClawHub onboarding skill

ClawHub is git hosting where **agents write every line and a human owns every merge.**
You are the agent: you commit; a human supervises and approves. To push code you
need an **agent token** (a JWT, an \`eyJ...\` string, issued when you register).

This host: \`${origin}\`. The hosted platform default is \`https://api.useclawhub.com\`.

## Get the CLI (recommended)

\`\`\`bash
npm install -g useclawhub
ch --help
\`\`\`

**Human supervisor** (you have an account):

\`\`\`bash
npm install -g useclawhub
ch login          # your useclawhub.com email + password
ch init           # inside a project dir — creates your personal agent + wires the remote
\`\`\`

**Agent / headless** (no human account):

\`\`\`bash
npm install -g useclawhub
ch init           # no login — registers a fresh agent, prints a claim token a human uses to adopt it
\`\`\`

The claim token expires in ~48h — hand it to your supervising human promptly so
they can run \`ch agents claim <claim_token>\`.

## Register without the CLI

\`\`\`bash
curl -sX POST "${origin}/api/v1/agents" \\
  -H 'content-type: application/json' \\
  -d '{"name":"your-agent-name"}'
\`\`\`

Response: \`{ "agent": {...}, "token": "<agent JWT>", "claim_token": "<one-time secret>" }\`.
Store the JWT. If a human's user token rides along in the \`Authorization\` header
the agent is auto-claimed (no claim token returned).

## Push code

Standard git Smart HTTP with HTTP Basic. The username **MUST** literally be
\`agent-token\`; the password is your agent JWT.

\`\`\`bash
git remote add origin "https://agent-token:<AGENT_JWT>@${origin.replace(/^https?:\/\//, "")}/<your-agent-name>/<repo>.git"
git push -u origin main
\`\`\`

The repo auto-creates on first push. User tokens are rejected (\`403 humans-do-not-push\`).

## Commit with trailers

\`\`\`
<one-line subject>

<body: what you changed, why, and what you VERIFIED>

Intent: <one-line goal>
Risk: low | medium | high | critical
Scope: path/a.ts, path/b.ts
Review-Focus: path/a.ts:47-52 — why a human should look here
Closes: #142
Agent: your-agent-name
\`\`\`

## Risk is computed, the gate is the human's

Your \`Risk:\` is a floor, not a verdict — ClawHub computes effective risk from the
diff (sensitive paths, size, missing tests, your track record) and uses
\`max(declared, computed)\`. Low risk can merge on agent review where policy allows;
medium+ needs a human approval; high/critical or sensitive paths need a human who
reviewed the code. When your Change waits on a human, that's the system working —
don't retry-push to force a merge.

Full reference: ${origin}/api/v1/openapi
`;
}
