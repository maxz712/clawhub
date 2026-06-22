"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { highlightLine, languageFor } from "@/lib/highlight";
import { parseLineHash, treeUrl } from "@/lib/repo-path";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BranchSelect } from "@/components/branch-select";
import { PathBreadcrumb } from "@/components/tree-listing";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Link2, Download } from "lucide-react";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;

/**
 * Binary blob: a Download button (and, for raster images, an inline preview).
 * The bytes are fetched WITH the bearer header and turned into an object URL —
 * so private-repo images render in <img> without a token in the URL — and the
 * URL is revoked on unmount.
 */
function BinaryView({ ns, repo, refName, path, size }: { ns: string; repo: string; refName: string; path: string; size: number }) {
  const isImage = IMAGE_RE.test(path);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    let objUrl: string | null = null;
    setPreviewUrl(null); setError(null);
    api.fetchRawBlob(ns, repo, path, refName)
      .then(({ blob }) => { if (cancelled) return; objUrl = URL.createObjectURL(blob); setPreviewUrl(objUrl); })
      .catch(e => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [ns, repo, refName, path, isImage]);

  async function download() {
    setDownloading(true); setError(null);
    try {
      const { blob } = await api.fetchRawBlob(ns, repo, path, refName);
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u; a.download = path.split("/").pop() ?? "file";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
    } catch (e) { setError((e as Error).message); }
    finally { setDownloading(false); }
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">Binary file ({formatSize(size)})</span>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={downloading} onClick={() => void download()}>
          <Download className="h-3.5 w-3.5" /> {downloading ? "…" : "Download"}
        </Button>
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
      {isImage && (
        previewUrl
          ? <img src={previewUrl} alt={path} className="max-w-full max-h-[480px] rounded border bg-[repeating-conic-gradient(#0000_0_25%,#1a1a1f_0_50%)] bg-[length:16px_16px]" />
          : !error && <div className="text-xs text-muted-foreground">Loading preview…</div>
      )}
    </div>
  );
}

/**
 * File view at /blob/<ref>/<path>. Line numbers are clickable: click selects
 * a line (#L12), shift-click extends to a range (#L12-L20) — the fragment
 * lands in the URL so the address bar is always shareable, GitHub-style.
 */
export function BlobView({ ns, repo, refName, path }: { ns: string; repo: string; refName: string; path: string }) {
  const [blob, setBlob] = useState<{ content: string | null; binary: boolean; truncated: boolean; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const scrolledOnce = useRef(false);

  useEffect(() => {
    setBlob(null); setError(null); scrolledOnce.current = false;
    api.getBlob(ns, repo, path, refName).then(setBlob).catch(e => setError((e as Error).message));
  }, [ns, repo, refName, path]);

  // Hash → selection (on load and back/forward).
  useEffect(() => {
    const apply = () => setSel(parseLineHash(window.location.hash));
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  // Scroll the anchored line into view once content is there.
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

  // Reflect the selection into the URL fragment outside of render — calling
  // history.replaceState inside the setState updater re-enters the router
  // mid-render and React rightfully complains.
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
  // Tokenize once per file — selection clicks re-render rows, and re-running
  // Prism over thousands of lines per click makes big files feel sticky.
  const highlighted = useMemo(() => lines.map(l => highlightLine(l, lang)), [lines, lang]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <BranchSelect ns={ns} repo={repo} current={refName} path={path} kind="blob" />
        <PathBreadcrumb ns={ns} repo={repo} refName={refName} path={path} />
        <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={copyPermalink}>
          <Link2 className="h-3.5 w-3.5" /> {copied ? "Copied!" : "Copy permalink"}
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="space-y-2">
            <div>{error}</div>
            <Link href={treeUrl(ns, repo, refName)} className="inline-block text-sm font-medium underline underline-offset-2">
              Back to repo root
            </Link>
          </AlertDescription>
        </Alert>
      ) : blob === null ? <div className="text-muted-foreground text-sm">Loading…</div> :
       blob.binary ? <BinaryView ns={ns} repo={repo} refName={refName} path={path} size={blob.size} /> : (
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
