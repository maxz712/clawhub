"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { RiskBadge } from "@/components/risk-badge";
import { Bot, Clock, AlertTriangle } from "lucide-react";

interface ChangeCardProps {
  repoId: string;
  change: {
    id: string;
    title?: string;
    description?: string;
    status: string;
    risk_level?: string;
    agent_name?: string;
    created_at?: string;
    intent?: {
      description?: string;
    };
    has_conflicts?: boolean;
  };
}

export function ChangeCard({ repoId, change }: ChangeCardProps) {
  const title = change.title || change.intent?.description || `Change ${change.id.slice(0, 8)}`;
  const timeAgo = change.created_at ? formatTimeAgo(change.created_at) : "";

  return (
    <Link href={`/dashboard/repos/${repoId}/changes/${change.id}`}>
      <Card className="bg-card border-border hover:border-primary/30 transition-colors cursor-pointer">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-sm font-medium leading-snug">
              {title}
            </CardTitle>
            <div className="flex items-center gap-2 flex-shrink-0">
              {change.has_conflicts && (
                <span className="flex items-center gap-1 text-amber-400 text-xs" title="Has merge conflicts">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Conflicts
                </span>
              )}
              {change.risk_level && <RiskBadge level={change.risk_level} />}
              <StatusBadge status={change.status} />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {change.description && (
            <p className="text-xs text-muted-foreground mb-2 line-clamp-2">
              {change.description}
            </p>
          )}
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            {change.agent_name && (
              <span className="flex items-center gap-1">
                <Bot className="h-3 w-3" />
                {change.agent_name}
              </span>
            )}
            {timeAgo && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {timeAgo}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  return date.toLocaleDateString();
}
