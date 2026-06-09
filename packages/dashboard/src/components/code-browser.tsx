"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type TreeEntry } from "@/lib/api";
import { highlightLine, languageFor } from "@/lib/highlight";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { File, Folder, CornerLeftUp } from "lucide-react";

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Stateful file explorer: directory listing with breadcrumbs, inline file
 * view, and the rendered README when sitting at a directory.
 */
export function CodeBrowser({ ns, repo, defaultBranch }: { ns: string; repo: string; defaultBranch: string }) {
  const [path, setPath] = useState("");          // current directory
  const [file, setFile] = useState<string | null>(null); // open file, if any
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [blob, setBlob] = useState<{ content: string | null; binary: boolean; truncated: boolean; size: number } | null>(null);
  const [readme, setReadme] = useState<{ name: string | null; html: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback((p: string) => {
    setError(null); setFile(null); setBlob(null);
    api.getTree(ns, repo, { path: p }).then(r => { setEntries(r.entries); setPath(p); })
      .catch(e => setError((e as Error).message));
    if (p === "") api.getReadme(ns, repo).then(setReadme).catch(() => setReadme(null));
  }, [ns, repo]);

  useEffect(() => { loadDir(""); }, [loadDir]);

  function openFile(p: string) {
    setError(null); setFile(p); setBlob(null);
    api.getBlob(ns, repo, p).then(setBlob).catch(e => setError((e as Error).message));
  }

  const crumbs = (file ?? path).split("/").filter(Boolean);

  return (
    <div className="space-y-4">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm font-mono flex-wrap">
        <button onClick={() => loadDir("")} className="text-primary hover:underline">{repo}</button>
        {crumbs.map((seg, i) => {
          const target = crumbs.slice(0, i + 1).join("/");
          const isLast = i === crumbs.length - 1;
          return (
            <span key={target} className="flex items-center gap-1">
              <span className="text-muted-foreground">/</span>
              {isLast ? <span>{seg}</span> :
                <button onClick={() => loadDir(target)} className="text-primary hover:underline">{seg}</button>}
            </span>
          );
        })}
        <span className="ml-auto text-xs text-muted-foreground">{defaultBranch}</span>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {/* File view */}
      {file !== null ? (
        blob === null ? <div className="text-muted-foreground text-sm">Loading…</div> :
        blob.binary ? <div className="text-muted-foreground text-sm p-4 rounded border bg-card">Binary file ({formatSize(blob.size)}).</div> : (
          <div className="rounded border bg-card overflow-hidden">
            <div className="px-3 py-2 border-b text-xs text-muted-foreground font-mono flex justify-between">
              <span>{formatSize(blob.size)}{blob.truncated ? " · truncated" : ""}</span>
              <span>{(blob.content?.split("\n").length ?? 0)} lines</span>
            </div>
            <pre className="overflow-x-auto text-xs leading-5 p-0 m-0">
              <code>
                {(() => {
                  const lang = languageFor(file);
                  return (blob.content ?? "").split("\n").map((line, i) => {
                    const html = highlightLine(line, lang);
                    return (
                      <div key={i} className="flex hover:bg-accent/50">
                        <span className="select-none w-12 shrink-0 text-right pr-3 text-muted-foreground/60 border-r mr-3">{i + 1}</span>
                        {html !== null
                          ? <span className="whitespace-pre" dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }} />
                          : <span className="whitespace-pre">{line || " "}</span>}
                      </div>
                    );
                  });
                })()}
              </code>
            </pre>
          </div>
        )
      ) : (
        <>
          {/* Directory listing */}
          <div className="rounded border bg-card divide-y">
            {path !== "" && (
              <button onClick={() => loadDir(path.split("/").slice(0, -1).join("/"))}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left">
                <CornerLeftUp className="h-4 w-4 text-muted-foreground" /> <span className="font-mono">..</span>
              </button>
            )}
            {entries.map(e => (
              <button key={e.path}
                onClick={() => e.type === "dir" ? loadDir(e.path) : openFile(e.path)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left">
                {e.type === "dir"
                  ? <Folder className="h-4 w-4 text-primary/70 shrink-0" />
                  : <File className="h-4 w-4 text-muted-foreground shrink-0" />}
                <span className="font-mono truncate">{e.name}</span>
                <span className="ml-auto text-xs text-muted-foreground font-mono shrink-0">{formatSize(e.size)}</span>
              </button>
            ))}
            {entries.length === 0 && <div className="px-3 py-4 text-sm text-muted-foreground">Empty directory.</div>}
          </div>

          {/* README at repo root */}
          {path === "" && readme?.html && (
            <div className="rounded border bg-card">
              <div className="px-4 py-2 border-b text-xs font-mono text-muted-foreground">{readme.name}</div>
              <div className="p-4 prose prose-invert prose-sm max-w-none [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:rounded [&_code]:text-primary [&_a]:text-primary"
                dangerouslySetInnerHTML={{ __html: readme.html }} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
