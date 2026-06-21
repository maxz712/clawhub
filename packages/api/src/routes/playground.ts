import { Hono } from "hono";
import { parseTrailers } from "../services/trailer-parser.js";
import { extractInlineReviewComments, mergeFocus } from "../services/focus-parser.js";

// Public, no-auth playground endpoints. Callers paste a commit message +
// diff + files; they get back parsed trailers + a focused diff render.
export function createPlaygroundRoutes(): Hono {
  const app = new Hono();

  app.post("/parse", async c => {
    const body = await c.req.json().catch(() => ({})) as { commitMessage?: string };
    if (!body.commitMessage) return c.json({ error: "commitMessage required" }, 400);
    const parsed = parseTrailers(body.commitMessage);
    return c.json({ parsed });
  });

  app.post("/focused-diff", async c => {
    const body = await c.req.json().catch(() => ({})) as {
      commitMessage?: string;
      diff?: string;
      files?: Array<{ path: string; content: string }>;
    };
    if (!body.diff) return c.json({ error: "diff required" }, 400);

    const parsed = parseTrailers(body.commitMessage ?? "");
    const inline = (body.files ?? []).flatMap(f => extractInlineReviewComments(f.path, f.content));
    const focus = mergeFocus(parsed.reviewFocus, inline);

    const byPath = new Map<string, Array<{ start: number; end: number; note?: string }>>();
    for (const f of focus) {
      (byPath.get(f.path) ?? byPath.set(f.path, []).get(f.path)!).push({ start: f.startLine, end: f.endLine, note: f.note });
    }

    const out: string[] = [];
    const files = body.diff.split(/(?=^diff --git )/m);
    for (const file of files) {
      const pathMatch = file.match(/^\+\+\+ b\/(.+)$/m);
      if (!pathMatch) continue;
      const ranges = byPath.get(pathMatch[1]);
      if (!ranges) continue;
      out.push(`### ${pathMatch[1]}`);
      const hunks = file.split(/(?=^@@ )/m);
      for (const h of hunks) {
        const hm = h.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (!hm) continue;
        const start = Number(hm[1]);
        const length = hm[2] ? Number(hm[2]) : 1;
        const end = start + length - 1;
        if (ranges.some(r => !(r.end < start - 3 || r.start > end + 3))) out.push(h.trimEnd());
      }
    }

    return c.json({
      parsed,
      focus,
      focused: out.join("\n\n"),
      fullDiffLines: body.diff.split("\n").length,
      focusedDiffLines: out.length ? out.join("\n").split("\n").length : 0,
    });
  });

  return app;
}
