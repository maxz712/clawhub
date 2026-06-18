"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type TreeEntry } from "@/lib/api";
import { blobUrl, treeUrl } from "@/lib/repo-path";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BranchSelect } from "@/components/branch-select";
import { File, Folder, CornerLeftUp } from "lucide-react";

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PathBreadcrumb({ ns, repo, refName, path, leafIsLink = false }: {
  ns: string; repo: string; refName: string; path: string; leafIsLink?: boolean;
}) {
  const segs = path.split("/").filter(Boolean);
  return (
    <div className="flex items-center gap-1 text-sm font-mono flex-wrap min-w-0">
      <Link href={treeUrl(ns, repo, refName)} className="text-primary hover:underline">{repo}</Link>
      {segs.map((seg, i) => {
        const sub = segs.slice(0, i + 1).join("/");
        const last = i === segs.length - 1;
        return (
          <span key={sub} className="flex items-center gap-1 min-w-0">
            <span className="text-muted-foreground">/</span>
            {last && !leafIsLink
              ? <span className="truncate">{seg}</span>
              : <Link href={treeUrl(ns, repo, refName, sub)} className="text-primary hover:underline truncate">{seg}</Link>}
          </span>
        );
      })}
    </div>
  );
}

/** Directory listing at /tree/<ref>/<path> — every row is a real link. */
export function TreeListing({ ns, repo, refName, path }: { ns: string; repo: string; refName: string; path: string }) {
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [readme, setReadme] = useState<{ name: string | null; html: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEntries(null); setError(null);
    api.getTree(ns, repo, { ref: refName, path }).then(r => setEntries(r.entries)).catch(e => setError((e as Error).message));
    if (path === "") api.getReadme(ns, repo, refName).then(setReadme).catch(() => setReadme(null));
    else setReadme(null);
  }, [ns, repo, refName, path]);

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <BranchSelect ns={ns} repo={repo} current={refName} path={path} />
        <PathBreadcrumb ns={ns} repo={repo} refName={refName} path={path} />
      </div>

      <div className="rounded-lg border bg-card divide-y">
        {path !== "" && (
          <Link href={treeUrl(ns, repo, refName, path.split("/").slice(0, -1).join("/"))}
            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent">
            <CornerLeftUp className="h-4 w-4 text-muted-foreground" /> <span className="font-mono">..</span>
          </Link>
        )}
        {entries === null && <div className="px-3 py-4 text-sm text-muted-foreground">Loading…</div>}
        {entries?.map(e => (
          <Link key={e.path}
            href={e.type === "dir" ? treeUrl(ns, repo, refName, e.path) : blobUrl(ns, repo, refName, e.path)}
            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent">
            {e.type === "dir"
              ? <Folder className="h-4 w-4 text-primary/70 shrink-0" />
              : <File className="h-4 w-4 text-muted-foreground shrink-0" />}
            <span className="font-mono truncate shrink-0 max-w-[40%]">{e.name}</span>
            {e.lastCommit && (
              <span className="text-xs text-muted-foreground truncate min-w-0 flex-1">{e.lastCommit.message}</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground font-mono shrink-0">
              {e.lastCommit ? new Date(e.lastCommit.authoredAt).toLocaleDateString() : formatSize(e.size)}
            </span>
          </Link>
        ))}
        {entries?.length === 0 && <div className="px-3 py-4 text-sm text-muted-foreground">Empty directory.</div>}
      </div>

      {path === "" && readme?.html && (
        <div className="rounded-lg border bg-card">
          <div className="px-4 py-2 border-b text-xs font-mono text-muted-foreground">{readme.name}</div>
          <div className="p-4 prose prose-invert prose-sm max-w-none [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:rounded [&_code]:text-primary [&_a]:text-primary"
            dangerouslySetInnerHTML={{ __html: readme.html }} />
        </div>
      )}
    </div>
  );
}
