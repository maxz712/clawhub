"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { pubBlobUrl, pubTreeUrl } from "@/lib/public-repo-path";
import { ChevronDown, GitBranch } from "lucide-react";

// Read-only branch switcher for the public repo surface. Mirrors BranchSelect
// but reads the anonymous publicBranches endpoint and navigates within /r/...
export function PublicBranchSelect({ ns, repo, current, path = "", kind = "tree" }: {
  ns: string; repo: string; current: string; path?: string; kind?: "tree" | "blob";
}) {
  const router = useRouter();
  const [branches, setBranches] = useState<Array<{ name: string; isDefault: boolean }>>([]);

  useEffect(() => {
    api.publicBranches(ns, repo).then(r => setBranches(r.branches)).catch(() => setBranches([]));
  }, [ns, repo]);

  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs">
      <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
      <select
        aria-label="Switch branch"
        className="appearance-none bg-transparent outline-none cursor-pointer max-w-72 truncate font-mono"
        value={current}
        onChange={e => {
          const ref = e.target.value;
          router.push(kind === "blob" && path ? pubBlobUrl(ns, repo, ref, path) : pubTreeUrl(ns, repo, ref, kind === "blob" ? "" : path));
        }}>
        {!branches.some(b => b.name === current) && <option value={current}>{current}</option>}
        {branches.map(b => (
          <option key={b.name} value={b.name}>{b.name}{b.isDefault ? " (default)" : ""}</option>
        ))}
      </select>
      <ChevronDown className="h-3 w-3 text-muted-foreground pointer-events-none" />
    </span>
  );
}
