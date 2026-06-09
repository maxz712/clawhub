"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";

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
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      const r = await api.playgroundFocusedDiff({ commitMessage, diff });
      setResult({ focused: r.focused, full: diff, parsed: r.parsed, fullDiffLines: r.fullDiffLines, focusedDiffLines: r.focusedDiffLines });
    } finally { setLoading(false); }
  }

  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-jbmono), monospace" }}>
      <nav style={{ padding: "16px 32px", borderBottom: "1px solid #2a2a33", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontFamily: "var(--font-jbmono), monospace", fontWeight: 700 }}>
          claw<span style={{ color: "#00e5a0" }}>hub</span>
        </Link>
        <Link href="/register" style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 13, background: "#00e5a0", color: "#0a0a0c", padding: "6px 14px", borderRadius: 6, textDecoration: "none", fontWeight: 600 }}>Sign up →</Link>
      </nav>

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
          style={{ background: "#00e5a0", color: "#0a0a0c", padding: "12px 28px", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-jbmono), monospace" }}>
          {loading ? "Rendering…" : "Render focused diff →"}
        </button>

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
              <div style={{ color: "#00e5a0", textTransform: "uppercase", letterSpacing: 2, fontSize: 11, marginBottom: 8, fontFamily: "var(--font-jbmono), monospace" }}>Focused diff</div>
              <pre style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 13, color: "#e8e8ed", margin: 0, whiteSpace: "pre-wrap" }}>{result.focused || "(no flagged lines found)"}</pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "#8888a0", marginBottom: 6, fontFamily: "var(--font-jbmono), monospace", textTransform: "uppercase", letterSpacing: 1 }}>{children}</div>;
}

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: "#16161b", border: "1px solid #2a2a33", borderRadius: 10, padding: 16 }}>
      <div style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 11, color: "#55556a", textTransform: "uppercase", letterSpacing: 2 }}>{label}</div>
      <div style={{ fontSize: 36, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}
