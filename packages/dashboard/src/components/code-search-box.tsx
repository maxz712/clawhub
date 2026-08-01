"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

// Trigram-index code search over the repo's default branch (/code/search).
// Surfaces the API's `truncated` flag so a capped result is never presented
// as complete (#109).
export function CodeSearchBox({ ns, repo, refName }: { ns: string; repo: string; refName: string }) {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ query: string; hits: Array<{ path: string; line: number; excerpt: string }>; truncated: boolean } | null>(null);

  const run = async () => {
    const query = q.trim();
    if (query.length < 3) { setError("Enter at least 3 characters"); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await api.codeSearch(ns, repo, query);
      setResult({ query, hits: res.hits, truncated: res.truncated });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-3 space-y-3">
      <form
        className="flex gap-2"
        onSubmit={e => { e.preventDefault(); run(); }}
      >
        <input
          value={q}
          onChange={e => { setQ(e.target.value); setError(null); }}
          placeholder={`Search code in ${ns}/${repo}…`}
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:border-primary disabled:opacity-50"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <div className="text-xs text-destructive">{error}</div>}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {result.hits.length} match{result.hits.length === 1 ? "" : "es"} for <code className="font-mono text-foreground">{result.query}</code>
            </span>
            <button className="hover:text-foreground" onClick={() => { setResult(null); setQ(""); }}>Clear</button>
          </div>
          {result.truncated && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-500">
              Results truncated — showing the first {result.hits.length} matches; refine your query to see the rest.
            </div>
          )}
          {result.hits.length === 0 ? (
            <div className="text-sm text-muted-foreground">No matches.</div>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {result.hits.map((h, i) => (
                <li key={`${h.path}:${h.line}:${i}`} className="px-3 py-1.5">
                  <Link
                    href={`/repos/${ns}/${repo}/blob/${refName}/${h.path}#L${h.line}`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    {h.path}:{h.line}
                  </Link>
                  <pre className="mt-0.5 overflow-x-auto font-mono text-xs text-muted-foreground">{h.excerpt.trim()}</pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
