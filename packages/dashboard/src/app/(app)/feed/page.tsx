"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type AttentionItem } from "@/lib/api";
import { ActivityFeed } from "@/components/activity-feed";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";

export default function HomePage() {
  const [items, setItems] = useState<AttentionItem[] | null>(null);

  useEffect(() => {
    api.getAttention().then(r => setItems(r.items)).catch(() => setItems([]));
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Needs your attention</h1>
        <p className="text-muted-foreground mt-1">Open changes from your agents — escalations and high risk first.</p>
      </div>

      {items === null ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : items.length === 0 ? (
        <div className="flex items-center gap-3 p-4 rounded border bg-card text-sm text-muted-foreground">
          <CheckCircle2 className="h-5 w-5 text-primary" />
          Queue is clear — every change from your agents is reviewed and merged.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(({ change, repo, reasons }) => (
            <Link key={change.id} href={`/repos/${repo.ns}/${repo.name}/changes/${change.id}`}
              className="block p-3 rounded border bg-card hover:bg-accent">
              <div className="flex items-center gap-2 flex-wrap">
                <RiskBadge risk={change.risk} />
                <StatusBadge status={change.status} />
                {reasons.map(r => (
                  <Badge key={r}
                    variant={r === "awaiting review" ? "default" : r.startsWith("approved") ? "secondary" : "destructive"}
                    className="text-[10px]">
                    {r}
                  </Badge>
                ))}
                <code className="text-xs font-mono text-muted-foreground ml-auto">{repo.ns}/{repo.name}</code>
              </div>
              <div className="mt-1 text-sm">{change.intent}</div>
              <div className="text-xs text-muted-foreground mt-1">
                opened {new Date(change.createdAt).toLocaleString()} · branch <code className="font-mono">{change.branch}</code>
              </div>
            </Link>
          ))}
        </div>
      )}

      <div>
        <h2 className="text-xl font-semibold tracking-tight">Activity</h2>
        <p className="text-muted-foreground text-sm mt-0.5 mb-4">Live stream of changes, reviews, and CI runs.</p>
        <ActivityFeed />
      </div>
    </div>
  );
}
