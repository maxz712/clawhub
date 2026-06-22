"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { highlightLine, languageFor } from "@/lib/highlight";
import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";

const SAMPLE_COMMIT = `Fix stale profile cache after updates

Intent: Fix stale cache bug on profile updates
Risk: low
Scope: src/api/profile.ts, src/cache.ts
Review-Focus: src/api/profile.ts:47-52 — new invalidation path
Agent: felix-openclaw
Closes: #42
`;

const SAMPLE_DIFF = `diff --git a/src/api/profile.ts b/src/api/profile.ts
--- a/src/api/profile.ts
+++ b/src/api/profile.ts
@@ -10,5 +10,5 @@ import { cache } from "../cache";
 export async function updateProfile(userId: string, patch: Partial<Profile>) {
-  await db.update(profiles).set(patch).where(eq(profiles.id, userId));
-  // TODO: invalidate cache
+  await db.update(profiles).set(patch).where(eq(profiles.id, userId));
+  await cache.del(\`profile:\${userId}\`);
 }
@@ -45,7 +45,9 @@ function hashProfile(p: Profile): string {
   return crypto.createHash("sha1").update(JSON.stringify(p)).digest("hex");
 }

-export async function readProfile(id: string): Promise<Profile> {
+export async function readProfile(id: string): Promise<Profile | null> {
+  const cached = await cache.get(\`profile:\${id}\`);
+  if (cached) return JSON.parse(cached);
   return db.select().from(profiles).where(eq(profiles.id, id)).limit(1).then(r => r[0]);
 }
@@ -120,3 +122,3 @@ export async function deleteProfile(id: string) {
-  await db.delete(profiles).where(eq(profiles.id, id));
+  await db.delete(profiles).where(eq(profiles.id, id));  // REVIEW: audit log?
 }
`;

export default function PlaygroundPage() {
  const [commitMessage, setCommitMessage] = useState(SAMPLE_COMMIT);
  const [diff, setDiff] = useState(SAMPLE_DIFF);
  const [result, setResult] = useState<{ focused: string; full: string; parsed: { intent?: string; risk?: string; reviewFocus?: Array<{ path: string; startLine: number; endLine: number; note?: string }> }; fullDiffLines: number; focusedDiffLines: number } | null>(null);
  const [view, setView] = useState<"focused" | "unified">("focused");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!diff.trim()) { setError("Paste a unified diff first — the diff box is empty."); return; }
    setLoading(true);
    setError(null);
    try {
      // Reconstruct each file's NEW content from the diff so the API can honor
      // inline `// REVIEW:` comments that live on added/context lines.
      const files = reconstructFilesFromDiff(diff);
      const r = await api.playgroundFocusedDiff({ commitMessage, diff, files });
      setResult({ focused: r.focused, full: diff, parsed: r.parsed, fullDiffLines: r.fullDiffLines, focusedDiffLines: r.focusedDiffLines });
    } catch (e) {
      setResult(null);
      setError((e as Error).message || "Couldn't render — check the diff is a valid unified diff, then try again.");
    } finally { setLoading(false); }
  }

  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <PublicHeader />

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "60px 24px" }}>
        <div style={{ fontFamily: "var(--font-jbmono), monospace", color: "#00e5a0", fontSize: 12, textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Playground</div>
        <h1 style={{ fontSize: 48, fontWeight: 800, letterSpacing: "-1.5px", margin: 0 }}>Try focused review</h1>
        <p style={{ color: "#8888a0", margin: "8px 0 32px" }}>
          Paste a commit message with trailers + a diff. See only the lines your agent asked to be reviewed.
          No signup required.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
          <div>
            <Label>Commit message (include Intent/Risk/Review-Focus trailers)</Label>
            <textarea value={commitMessage} onChange={e => setCommitMessage(e.target.value)} rows={12}
              style={{ width: "100%", fontFamily: "var(--font-jbmono), monospace", fontSize: 13, background: "#16161b", color: "#e8e8ed", border: "1px solid #2a2a33", borderRadius: 8, padding: 12 }} />
          </div>
          <div>
            <Label>Unified diff</Label>
            <textarea value={diff} onChange={e => setDiff(e.target.value)} rows={12}
              style={{ width: "100%", fontFamily: "var(--font-jbmono), monospace", fontSize: 13, background: "#16161b", color: "#e8e8ed", border: "1px solid #2a2a33", borderRadius: 8, padding: 12 }} />
          </div>
        </div>

        <button onClick={run} disabled={loading}
          style={{ background: "#00e5a0", color: "#0a0a0c", padding: "12px 28px", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-outfit), sans-serif" }}>
          {loading ? "Rendering…" : "Render focused diff →"}
        </button>

        {error && (
          <div style={{ marginTop: 16, background: "rgba(255,95,95,0.08)", border: "1px solid #ff5f5f", borderRadius: 8, padding: "12px 16px", color: "#ff8a8a", fontSize: 14 }}>
            {error}
          </div>
        )}

        {result && (
          <>
            <div style={{ marginTop: 40, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
              <StatBox label="Full diff lines" value={result.fullDiffLines} color="#8888a0" />
              <StatBox label="Focused lines" value={result.focusedDiffLines} color="#00e5a0" />
              <StatBox label="Parsed focus ranges" value={result.parsed.reviewFocus?.length ?? 0} color="#ffd75f" />
            </div>

            <div style={{ marginTop: 24, background: "#16161b", border: "1px solid #2a2a33", borderRadius: 10, padding: 20, fontFamily: "var(--font-jbmono), monospace", fontSize: 13 }}>
              <div style={{ color: "#00e5a0", textTransform: "uppercase", letterSpacing: 2, fontSize: 11, marginBottom: 8 }}>Parsed metadata</div>
              <div style={{ color: "#e8e8ed" }}>Intent: <span style={{ color: "#8888a0" }}>{result.parsed.intent ?? "—"}</span></div>
              <div style={{ color: "#e8e8ed" }}>Risk: <span style={{ color: "#00e5a0" }}>{result.parsed.risk ?? "—"}</span></div>
              {(result.parsed.reviewFocus ?? []).map((f, i) => (
                <div key={i} style={{ color: "#ffd75f" }}>Review-Focus: {f.path}:{f.startLine}-{f.endLine}{f.note ? ` — ${f.note}` : ""}</div>
              ))}
            </div>

            <div style={{ marginTop: 24, background: "#16161b", border: "1px solid #00e5a0", borderRadius: 10, padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
                <div style={{ color: "#00e5a0", textTransform: "uppercase", letterSpacing: 2, fontSize: 11, fontFamily: "var(--font-jbmono), monospace" }}>
                  {view === "focused" ? "Focused diff" : "Unified diff"}
                </div>
                <div style={{ display: "flex", border: "1px solid #2a2a33", borderRadius: 6, overflow: "hidden", fontFamily: "var(--font-jbmono), monospace", fontSize: 11 }}>
                  {(["focused", "unified"] as const).map(v => (
                    <button key={v} onClick={() => setView(v)} style={{
                      padding: "5px 14px", border: "none", cursor: "pointer", textTransform: "capitalize",
                      background: view === v ? "#00e5a0" : "transparent", color: view === v ? "#0a0a0c" : "#8888a0", fontWeight: 600,
                    }}>{v}</button>
                  ))}
                </div>
              </div>
              {view === "focused"
                ? (result.focused ? <HighlightedDiff text={result.focused} /> : (
                    <div style={{ color: "#8888a0", fontFamily: "var(--font-outfit), sans-serif", fontSize: 14, lineHeight: 1.6 }}>
                      No <code style={{ fontFamily: "var(--font-jbmono), monospace", color: "#ffd75f" }}>Review-Focus</code> trailer matched this diff, so there&apos;s nothing to focus on.
                      Add a line like <code style={{ fontFamily: "var(--font-jbmono), monospace", color: "#ffd75f" }}>Review-Focus: path/to/file.ts:10-20 — why</code> to your commit message
                      (the path + line range must fall inside the diff). <Link href="/docs" style={{ color: "#00e5a0" }}>See the trailer docs →</Link>
                    </div>
                  ))
                : <HighlightedDiff text={result.full} />}
            </div>

            <div style={{ marginTop: 24, background: "#16161b", border: "1px solid #2a2a33", borderRadius: 10, padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ color: "#c0c0d0", fontSize: 14 }}>
                This is exactly what a human reviewer sees on every Change — only the lines your agent flagged.
              </div>
              <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
                <Link href="/register" style={{ background: "#00e5a0", color: "#0a0a0c", padding: "10px 20px", borderRadius: 8, fontWeight: 700, textDecoration: "none", fontSize: 14 }}>Create your first repo →</Link>
                <Link href="/docs" style={{ background: "transparent", color: "#e8e8ed", border: "1px solid #3a3a44", padding: "10px 20px", borderRadius: 8, fontWeight: 600, textDecoration: "none", fontSize: 14 }}>Read the docs</Link>
              </div>
            </div>
          </>
        )}
      </div>
      <PublicFooter />
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "#8888a0", marginBottom: 6, fontFamily: "var(--font-jbmono), monospace", textTransform: "uppercase", letterSpacing: 1 }}>{children}</div>;
}

/**
 * Reconstruct each file's NEW content from a pasted unified diff. For every
 * `diff --git a/X b/X` section we rebuild the post-image: added (`+`) and
 * context (` `) lines are kept (with their leading marker stripped); removed
 * (`-`) lines are dropped; hunk headers (`@@`) and file headers (`diff --git`,
 * `index`, `---`, `+++`) are skipped. The path is the `b/` side, falling back
 * to the `a/` side when the new path is /dev/null (a deletion). This lets the
 * API run `extractInlineReviewComments` over the real post-image so inline
 * `// REVIEW:` comments on added lines are honored.
 */
function reconstructFilesFromDiff(diff: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const sections = diff.split(/(?=^diff --git )/m);
  for (const section of sections) {
    if (!/^diff --git /m.test(section)) continue;
    const bMatch = section.match(/^\+\+\+ (?:b\/)?(.+)$/m);
    const aMatch = section.match(/^--- (?:a\/)?(.+)$/m);
    let path: string | null = null;
    if (bMatch && bMatch[1] !== "/dev/null") path = bMatch[1].trim();
    else if (aMatch && aMatch[1] !== "/dev/null") path = aMatch[1].trim();
    if (!path) continue;

    // CRITICAL: place each kept (added/context) line at its REAL new-file line
    // number — parsed from the hunk header `@@ -a,b +c,d @@` — and pad gaps
    // between hunks with blanks. The server numbers inline `// REVIEW:` comments
    // by position in this content and tests those line numbers against each
    // hunk's real `@@ +start` range, so a naive 1..N concatenation would map a
    // comment in hunk 3 onto hunk 1. byLine is sparse (1-based) → join fills gaps.
    const byLine = new Map<number, string>();
    let newLine = 0;
    let inHunk = false;
    for (const line of section.split("\n")) {
      const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) { newLine = parseInt(h[1], 10); inHunk = true; continue; }
      if (!inHunk) continue; // skip diff --git / index / --- / +++ headers
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      if (line.startsWith("-")) continue; // removed — not in the new file, no line advance
      if (line.startsWith("+") || line.startsWith(" ")) { byLine.set(newLine, line.slice(1)); newLine++; }
      else if (line === "") { byLine.set(newLine, ""); newLine++; } // empty context line
    }
    if (newLine === 0) continue; // no hunks parsed
    const maxLine = Math.max(0, ...byLine.keys());
    const lines: string[] = [];
    for (let i = 1; i <= maxLine; i++) lines.push(byLine.get(i) ?? "");
    out.push({ path, content: lines.join("\n") });
  }
  return out;
}

/**
 * Render a unified/focused diff with per-line syntax highlighting, mirroring the
 * in-app diff viewer: header lines are muted, +/- lines get a colored marker and
 * tinted background, and the code body is Prism-highlighted in the file's
 * language (tracked from `### path` / `+++ b/path` headers). Line-by-line
 * tokenizing loses multi-line state — the same trade-off the app's diff makes.
 */
function HighlightedDiff({ text }: { text: string }) {
  let lang: string | null = null;
  const NBSP = " ";
  return (
    <pre style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 13, margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.7, overflowX: "auto" }}>
      {text.split("\n").map((line, i) => {
        const fileHdr = line.match(/^### (.+)$/) ?? line.match(/^\+\+\+ b\/(.+)$/);
        if (fileHdr) lang = languageFor(fileHdr[1]);
        if (/^(### |diff --git |index |--- |\+\+\+ |@@ )/.test(line)) {
          const color = line.startsWith("@@") ? "#8aa0ff" : line.startsWith("### ") ? "#00e5a0" : "#55556a";
          return <div key={i} style={{ color }}>{line || NBSP}</div>;
        }
        const marker = line[0] ?? "";
        const body = line.slice(1);
        const isAdd = marker === "+", isDel = marker === "-";
        const html = highlightLine(body, lang);
        return (
          <div key={i} style={{ display: "flex", background: isAdd ? "rgba(0,229,160,0.08)" : isDel ? "rgba(255,95,95,0.08)" : "transparent" }}>
            <span style={{ width: 14, flexShrink: 0, userSelect: "none", color: isAdd ? "#00e5a0" : isDel ? "#ff6b6b" : "#55556a" }}>{marker || NBSP}</span>
            {html
              ? <span style={{ flex: 1 }} dangerouslySetInnerHTML={{ __html: html || NBSP }} />
              : <span style={{ flex: 1, color: "#e8e8ed" }}>{body || NBSP}</span>}
          </div>
        );
      })}
    </pre>
  );
}

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: "#16161b", border: "1px solid #2a2a33", borderRadius: 10, padding: 16 }}>
      <div style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 11, color: "#55556a", textTransform: "uppercase", letterSpacing: 2 }}>{label}</div>
      <div style={{ fontSize: 36, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}
