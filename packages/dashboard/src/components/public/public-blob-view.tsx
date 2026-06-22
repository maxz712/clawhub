"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { highlightLine, languageFor } from "@/lib/highlight";
import { parseLineHash, pubTreeUrl } from "@/lib/public-repo-path";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PublicBranchSelect } from "@/components/public/public-branch-select";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Link2 } from "lucide-react";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Read-only file view for the public surface. Mirrors BlobView. */
export function PublicBlobView({ ns, repo, refName, path }: { ns: string; repo: string; refName: string; path: string }) {
  const [blob, setBlob] = useState<{ content: string | null; binary: boolean; truncated: boolean; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const scrolledOnce = useRef(false);

  useEffect(() => {
    setBlob(null); setError(null); scrolledOnce.current = false;
    api.publicBlob(ns, repo, path, refName).then(setBlob).catch(e => setError((e as Error).message));
  }, [ns, repo, refName, path]);

  useEffect(() => {
    const apply = () => setSel(parseLineHash(window.location.hash));
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  useEffect(() => {
    if (!blob || !sel || scrolledOnce.current) return;
    scrolledOnce.current = true;
    document.getElementById(`L${sel.start}`)?.scrollIntoView({ block: "center" });
  }, [blob, sel]);

  const clickLine = useCallback((n: number, shift: boolean) => {
    setSel(prev => shift && prev
      ? { start: Math.min(prev.start, n), end: Math.max(prev.start, n) }
      : { start: n, end: n });
  }, []);

  useEffect(() => {
    if (!sel) return;
    const hash = sel.start === sel.end ? `#L${sel.start}` : `#L${sel.start}-L${sel.end}`;
    if (window.location.hash !== hash) history.replaceState(null, "", hash);
  }, [sel]);

  async function copyPermalink() {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const lang = languageFor(path);
  const lines = useMemo(() => blob?.content?.split("\n") ?? [], [blob]);
  const highlighted = useMemo(() => lines.map(l => highlightLine(l, lang)), [lines, lang]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <PublicBranchSelect ns={ns} repo={repo} current={refName} path={path} kind="blob" />
        <Link href={pubTreeUrl(ns, repo, refName, path.split("/").slice(0, -1).join("/"))} className="text-sm font-mono text-primary hover:underline truncate">{path}</Link>
        <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={copyPermalink}>
          <Link2 className="h-3.5 w-3.5" /> {copied ? "Copied!" : "Copy permalink"}
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="space-y-2">
            <div>{error}</div>
            <Link href={pubTreeUrl(ns, repo, refName)} className="inline-block text-sm font-medium underline underline-offset-2">Back to repo root</Link>
          </AlertDescription>
        </Alert>
      ) : blob === null ? <div className="text-muted-foreground text-sm">Loading…</div> :
       blob.binary ? <div className="text-muted-foreground text-sm p-4 rounded-lg border bg-card">Binary file ({formatSize(blob.size)}).</div> : (
        <div className="rounded-lg border bg-card overflow-hidden">
          {blob.truncated && (
            <div className="flex items-center gap-2 px-3 py-2 border-b bg-yellow-400/10 text-yellow-500 text-xs font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Showing first {formatSize(blob.content?.length ?? 0)} — file truncated ({formatSize(blob.size)} total).
            </div>
          )}
          <div className="px-3 py-2 border-b text-xs text-muted-foreground font-mono flex justify-between">
            <span>{formatSize(blob.size)}{blob.truncated ? " · truncated" : ""}</span>
            <span>{lines.length} lines</span>
          </div>
          <pre className="overflow-x-auto text-xs leading-5 p-0 m-0">
            <code>
              {lines.map((line, i) => {
                const n = i + 1;
                const selected = sel && n >= sel.start && n <= sel.end;
                const html = highlighted[i];
                return (
                  <div key={n} id={`L${n}`}
                    className={`flex scroll-mt-24 ${selected ? "bg-yellow-400/10" : "hover:bg-accent/50"}`}>
                    <button
                      onClick={e => clickLine(n, e.shiftKey)}
                      className={`select-none w-12 shrink-0 text-right pr-3 border-r mr-3 cursor-pointer ${
                        selected ? "text-yellow-400 border-l-2 border-l-yellow-400" : "text-muted-foreground/60 hover:text-foreground border-l-2 border-l-transparent"}`}>
                      {n}
                    </button>
                    {html !== null
                      ? <span className="whitespace-pre" dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }} />
                      : <span className="whitespace-pre">{line || " "}</span>}
                  </div>
                );
              })}
            </code>
          </pre>
        </div>
      )}
    </div>
  );
}
