import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { executeGraphQL } from "../services/graphql.js";

export function createGraphQLRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // Disabled by default. The resolver layer is NOT yet authorization-scoped per
  // caller (see services/graphql.ts) — until it is, an enabled GraphQL endpoint
  // would let any valid token read across tenants. Operators opt in explicitly
  // with CLAWHUB_GRAPHQL_ENABLED=true once they accept that. Closes the
  // 2026-06-20 audit "GraphQL zero-authz cross-tenant dump" finding.
  const enabled = process.env.CLAWHUB_GRAPHQL_ENABLED === "true";

  app.post("/", async c => {
    if (!enabled) return c.json({ errors: [{ message: "graphql is disabled (set CLAWHUB_GRAPHQL_ENABLED=true to enable)" }] }, 404);
    const p = c.get("tokenPayload");
    const body = await c.req.json().catch(() => ({})) as { query?: string };
    if (!body.query) return c.json({ errors: [{ message: "missing query" }] }, 400);
    const ctx = { db, userId: p.kind === "user" ? p.userId : undefined, agentId: p.kind === "agent" ? p.agentId : undefined };
    const result = await executeGraphQL(body.query, ctx);
    return c.json(result);
  });

  // Minimal GraphiQL-ish IDE.
  app.get("/", c => {
    if (!enabled) return c.text("graphql is disabled (set CLAWHUB_GRAPHQL_ENABLED=true to enable)", 404);
    return c.html(`<!doctype html><html><head><title>ClawHub GraphQL</title>
  <style>body{font-family:system-ui;background:#0a0a0c;color:#e8e8ed;margin:0}
  header{padding:16px;border-bottom:1px solid #2a2a33} main{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px;height:calc(100vh - 70px)}
  textarea,pre{background:#16161b;border:1px solid #2a2a33;border-radius:6px;padding:12px;font-family:monospace;width:100%;height:100%;color:#e8e8ed}
  button{background:#00e5a0;color:#0a0a0c;border:none;padding:8px 16px;border-radius:4px;font-weight:700}</style>
  </head><body>
  <header><strong>ClawHub GraphQL</strong> <button id="run">Run ▶</button></header>
  <main>
  <textarea id="q">{ health me { kind id } repos { id name defaultBranch } }</textarea>
  <pre id="out"></pre>
  </main>
  <script>
  document.getElementById('run').onclick=async()=>{
    const token=localStorage.getItem('clawhub_token')||'';
    const r=await fetch('/api/v1/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({query:document.getElementById('q').value})});
    document.getElementById('out').textContent=JSON.stringify(await r.json(),null,2);
  };
  </script></body></html>`);
  });

  return app;
}
