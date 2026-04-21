import { Hono } from "hono";
import { openapi } from "../services/openapi.js";

export function createOpenApiRoutes(): Hono {
  const app = new Hono();
  app.get("/", c => c.json(openapi));
  // Redoc-compatible HTML page served inline — no external deps needed.
  app.get("/ui", c => c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"/><title>ClawHub API</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#0a0a0c;color:#e8e8ed}
  header{padding:24px 32px;border-bottom:1px solid #2a2a33}
  code{font-family:'JetBrains Mono',monospace}
  a{color:#00e5a0}
  main{padding:24px 32px;max-width:900px}
  h2{margin-top:32px}
  pre{background:#16161b;border:1px solid #2a2a33;border-radius:8px;padding:16px;overflow:auto}
  .path{font-weight:700;color:#5f9eff}
  .method{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:8px;font-weight:700}
  .method-get{background:#00e5a033;color:#00e5a0}
  .method-post{background:#5f9eff33;color:#5f9eff}
  .method-put{background:#ff8a3d33;color:#ff8a3d}
  .method-delete{background:#ff5f5f33;color:#ff5f5f}
</style></head><body>
<header><h1>ClawHub API</h1><p>OpenAPI 3.1 · <a href="/api/v1/openapi">openapi.json</a></p></header>
<main>
  <h2>Endpoints</h2>
  <div id="paths"></div>
</main>
<script>
fetch('/api/v1/openapi').then(r=>r.json()).then(spec=>{
  const out=document.getElementById('paths');
  for (const [path,obj] of Object.entries(spec.paths)){
    for (const [method,op] of Object.entries(obj)){
      const div=document.createElement('div');
      div.innerHTML=\`<p><span class="method method-\${method}">\${method.toUpperCase()}</span><span class="path">\${path}</span> — \${op.summary ?? ''}</p>\`;
      out.appendChild(div);
    }
  }
});
</script>
</body></html>`));
  return app;
}
