"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { treeUrl } from "@/lib/repo-path";
import { GitBranch } from "lucide-react";

export function BranchSelect({ ns, repo, current }: {
  // `path`/`kind` remain in the prop contract (callers pass them for the tree/blob
  // context) but no longer steer the target URL: a branch switch always lands on
  // the branch root, which is guaranteed to exist, so it never 404s on a deep path.
  ns: string; repo: string; current: string; path?: string; kind?: "tree" | "blob";
}) {
  const router = useRouter();
  const [branches, setBranches] = useState<Array<{ name: string; isDefault: boolean }>>([]);

  useEffect(() => {
    api.getBranches(ns, repo).then(r => setBranches(r.branches)).catch(() => setBranches([]));
  }, [ns, repo]);

  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs">
      <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
      <select
        aria-label="Switch branch"
        className="bg-transparent outline-none cursor-pointer max-w-44 truncate"
        value={current}
        onChange={e => {
          const ref = e.target.value;
          // The current deep path (a subdir or a file) may not exist on the
          // target branch — landing there 404s. Switch to the branch ROOT, which
          // always exists for a non-empty repo, so a branch switch never throws a
          // destructive 404.
          router.push(treeUrl(ns, repo, ref));
        }}>
        {!branches.some(b => b.name === current) && <option value={current}>{current}</option>}
        {branches.map(b => (
          <option key={b.name} value={b.name}>{b.name}{b.isDefault ? " (default)" : ""}</option>
        ))}
      </select>
    </span>
  );
}
