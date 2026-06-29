"use client";

import { use } from "react";
import Link from "next/link";
import { MemoryView } from "@/components/memory-view";

export default function MemoryPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  return (
    <div className="space-y-3">
      {/* This agent feature also lives in the unified Agents hub (Memory tab),
          where you can switch repos without leaving the section. */}
      <div className="text-xs text-muted-foreground">
        <Link href={`/agents/memory?repo=${encodeURIComponent(`${ns}/${repo}`)}`} className="hover:text-foreground hover:underline">
          See all agent memory in the Agents hub →
        </Link>
      </div>
      <MemoryView ns={ns} repo={repo} />
    </div>
  );
}
