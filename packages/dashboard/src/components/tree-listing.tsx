"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, type TreeEntry } from "@/lib/api";
import { blobUrl, rewriteRelativeLinks, treeUrl } from "@/lib/repo-path";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BranchSelect } from "@/components/branch-select";
import { File, Folder, CornerLeftUp, BookText } from "lucide-react";

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
  // A 404 at the repo root means the ref has no commits — render an empty-repo
  // onboarding state rather than a destructive error.
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setEntries(null); setError(null); setMissing(false);
    api.getTree(ns, repo, { ref: refName, path }).then(r => setEntries(r.entries)).catch(e => {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError((e as Error).message);
    });
    if (path === "") api.getReadme(ns, repo, refName).then(setReadme).catch(() => setReadme(null));
    else setReadme(null);
  }, [ns, repo, refName, path]);

  const rootHref = treeUrl(ns, repo, refName);

  // Empty repo / ref with no commits at the root: friendly onboarding, no red Alert.
  if (missing && path === "") {
    return (
      <div className="rounded-lg border bg-card p-8 text-center space-y-2">
        <div className="text-base font-medium">No code yet</div>
        <p className="text-sm text-muted-foreground">
          Push your first branch to get started — the first branch you push becomes the repo&apos;s default branch.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <BranchSelect ns={ns} repo={repo} current={refName} path={path} />
        <PathBreadcrumb ns={ns} repo={repo} refName={refName} path={path} />
      </div>

      {(error || missing) && (
        <Alert variant="destructive">
          <AlertDescription className="space-y-2">
            <div>{error ?? `tree ${refName}:${path} not found`}</div>
            <Link href={rootHref} className="inline-block text-sm font-medium underline underline-offset-2">
              Back to repo root
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {!error && !missing && <div className="rounded-lg border bg-card divide-y">
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
            <span className="font-mono truncate shrink-0 max-w-[55%] sm:max-w-[40%]">{e.name}</span>
            {e.lastCommit && (
              <span className="text-xs text-muted-foreground truncate min-w-0 flex-1">{e.lastCommit.message}</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground font-mono shrink-0">
              {e.lastCommit ? new Date(e.lastCommit.authoredAt).toLocaleDateString() : formatSize(e.size)}
            </span>
          </Link>
        ))}
        {entries?.length === 0 && <div className="px-3 py-4 text-sm text-muted-foreground">Empty directory.</div>}
      </div>}

      {path === "" && readme?.html && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b bg-secondary/30">
            <BookText className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium">{readme.name}</span>
          </div>
          <div className="markdown-body px-6 py-5" dangerouslySetInnerHTML={{ __html: rewriteRelativeLinks(readme.html, p => blobUrl(ns, repo, refName, p)) }} />
        </div>
      )}
    </div>
  );
}
