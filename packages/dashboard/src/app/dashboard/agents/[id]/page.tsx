"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { StatCard } from "@/components/stat-card";
import {
  Loader2,
  Bot,
  AlertCircle,
  GitMerge,
  GitFork,
  AlertTriangle,
  Clock,
  CheckCircle,
  Activity,
} from "lucide-react";

interface AgentDetail {
  id: string;
  name: string;
  type?: string;
  status?: string;
  created_at?: string;
  owner_id?: string;
  repos?: Array<{ id: string; name: string; owner?: string }>;
  recent_activity?: Array<{
    id?: string;
    event_type?: string;
    description?: string;
    repo_name?: string;
    created_at?: string;
  }>;
  stats?: {
    changes_submitted?: number;
    changes_merged?: number;
    changes_rejected?: number;
    escalation_count?: number;
    reviews_given?: number;
  };
}

export default function AgentProfilePage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!agentId) return;

    api
      .getAgent(agentId)
      .then((data) => {
        setAgent(data.agent || data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <AlertCircle className="h-8 w-8 text-destructive mb-2" />
        <p className="text-destructive">{error || "Agent not found"}</p>
      </div>
    );
  }

  const stats = agent.stats || {};

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/dashboard/agents" className="hover:text-foreground">
          Agents
        </Link>
        <span>/</span>
        <span className="text-foreground">{agent.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="h-6 w-6 text-muted-foreground" />
            {agent.name}
          </h1>
          <div className="flex items-center gap-3 mt-2">
            <Badge
              variant="outline"
              className={
                agent.status === "active"
                  ? "bg-green-500/15 text-green-400 border-green-500/30"
                  : "bg-gray-500/15 text-gray-400 border-gray-500/30"
              }
            >
              {agent.status || "active"}
            </Badge>
            <span className="text-sm text-muted-foreground capitalize">
              {(agent.type || "unknown").replace(/_/g, " ")}
            </span>
            {agent.created_at && (
              <span className="text-sm text-muted-foreground flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                Since {new Date(agent.created_at).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          title="Merged"
          value={stats.changes_merged ?? 0}
          icon={GitMerge}
          description="Changes merged"
        />
        <StatCard
          title="Submitted"
          value={stats.changes_submitted ?? 0}
          icon={CheckCircle}
          description="Total submitted"
        />
        <StatCard
          title="Escalated"
          value={stats.escalation_count ?? 0}
          icon={AlertTriangle}
          description="Times escalated"
        />
        <StatCard
          title="Reviews"
          value={stats.reviews_given ?? 0}
          icon={Activity}
          description="Reviews given"
        />
      </div>

      {/* Repos */}
      {agent.repos && agent.repos.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <GitFork className="h-4 w-4" />
              Repositories ({agent.repos.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {agent.repos.map((repo) => (
              <Link
                key={repo.id}
                href={`/dashboard/repos/${repo.owner || "_"}/${repo.name}`}
                className="block text-sm hover:text-primary transition-colors"
              >
                {repo.owner ? `${repo.owner}/` : ""}{repo.name}
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Recent Activity */}
      {agent.recent_activity && agent.recent_activity.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {agent.recent_activity.map((event, i) => (
              <div
                key={event.id || i}
                className="flex items-start gap-3 text-sm border-b border-border/50 pb-3 last:border-0"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-foreground leading-snug">
                    {event.description || event.event_type || "Activity"}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                    {event.repo_name && <span>in {event.repo_name}</span>}
                    {event.created_at && (
                      <span>{new Date(event.created_at).toLocaleString()}</span>
                    )}
                  </div>
                </div>
                {event.event_type && (
                  <Badge variant="outline" className="text-[10px] capitalize flex-shrink-0">
                    {event.event_type}
                  </Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
