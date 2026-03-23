"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, HelpCircle, ShieldAlert, Clock, Check, X } from "lucide-react";

export interface AttentionItem {
  id: string;
  type: "uncertainty" | "policy_gate" | "conflict";
  repo_name?: string;
  repo_id?: string;
  change_id?: string;
  change_title?: string;
  branch_name?: string;
  agent_name?: string;
  reason: string;
  key_decision?: string;
  file_path?: string;
  file_lines?: string;
  created_at?: string;
  risk_level?: string;
  owner?: string;
}

const typeConfig: Record<string, { icon: typeof AlertTriangle; color: string; label: string; badgeClass: string }> = {
  uncertainty: {
    icon: HelpCircle,
    color: "text-yellow-400",
    label: "UNCERTAINTY",
    badgeClass: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  },
  policy_gate: {
    icon: ShieldAlert,
    color: "text-red-400",
    label: "POLICY GATE",
    badgeClass: "bg-red-500/15 text-red-400 border-red-500/30",
  },
  conflict: {
    icon: AlertTriangle,
    color: "text-red-400",
    label: "CONFLICT",
    badgeClass: "bg-red-500/15 text-red-400 border-red-500/30",
  },
};

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

interface AttentionCardProps {
  item: AttentionItem;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
}

export function AttentionCard({ item, onApprove, onReject }: AttentionCardProps) {
  const config = typeConfig[item.type] || typeConfig.uncertainty;
  const Icon = config.icon;

  return (
    <Card className="bg-card border-border hover:border-primary/20 transition-colors">
      <CardContent className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Icon className={`h-4 w-4 ${config.color}`} />
            <Badge variant="outline" className={config.badgeClass}>
              {config.label}
            </Badge>
          </div>
          {item.created_at && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTimeAgo(item.created_at)}
            </span>
          )}
        </div>

        {/* Repo / Change info */}
        <div className="mb-2">
          {item.repo_name && (
            <span className="text-xs text-muted-foreground">
              {item.owner ? `${item.owner}/` : ""}{item.repo_name}
              {item.branch_name && ` / ${item.branch_name}`}
            </span>
          )}
          {item.change_title && (
            <p className="text-sm font-medium mt-0.5">{item.change_title}</p>
          )}
        </div>

        {/* Reason */}
        <p className="text-sm text-muted-foreground mb-3">{item.reason}</p>

        {/* Key decision */}
        {item.key_decision && (
          <div className="text-sm mb-3">
            <span className="text-muted-foreground">Key decision: </span>
            <span>{item.key_decision}</span>
            {item.file_path && (
              <div className="mt-1 text-xs font-mono text-blue-400">
                {item.file_path}
                {item.file_lines && `:${item.file_lines}`}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 mt-3">
          {onApprove && (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white h-7 text-xs"
              onClick={(e) => { e.preventDefault(); onApprove(item.id); }}
            >
              <Check className="h-3 w-3 mr-1" />
              Approve & Merge
            </Button>
          )}
          {onReject && (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-xs"
              onClick={(e) => { e.preventDefault(); onReject(item.id); }}
            >
              <X className="h-3 w-3 mr-1" />
              Reject
            </Button>
          )}
          <Link
            href={`/dashboard/attention/${item.id}`}
            className="text-xs text-muted-foreground hover:text-foreground ml-auto"
          >
            View Details
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
