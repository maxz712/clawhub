"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HealthDot, computeRepoHealth } from "@/components/health-badge";
import { Loader2, Bot, Clock, GitMerge, AlertCircle, Bell } from "lucide-react";

interface RepoHealth {
  id: string;
  name: string;
  owner?: string;
  active_agent?: string;
  escalated_count?: number;
  pending_count?: number;
  merged_count?: number;
  last_activity?: string;
  has_conflicts?: boolean;
  description?: string;
}

interface DashboardStats {
  total_repos: number;
  total_agents: number;
  pending_changes: number;
  merged_changes: number;
  attention_count?: number;
}

export default function DashboardPage() {
  const [repos, setRepos] = useState<RepoHealth[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getRepos().catch(() => []),
      api.getStats().catch(() => null),
    ])
      .then(([repoData, statsData]) => {
        const items = Array.isArray(repoData) ? repoData : repoData.repos || repoData.repositories || [];
        setRepos(items);
        if (statsData) {
          setStats(statsData.stats || statsData);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const attentionCount = stats?.attention_count || repos.reduce((sum, r) => sum + (r.escalated_count || 0), 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Mission Control</h1>
        <p className="text-muted-foreground mt-1">
          Project health at a glance. Green means everything is flowing.
        </p>
      </div>

      {/* Quick stats bar */}
      <div className="flex items-center gap-6 text-sm">
        {attentionCount > 0 && (
          <Link
            href="/dashboard/attention"
            className="flex items-center gap-2 text-yellow-400 hover:text-yellow-300 transition-colors"
          >
            <Bell className="h-4 w-4" />
            <span className="font-medium">{attentionCount} item{attentionCount !== 1 ? "s" : ""} need{attentionCount === 1 ? "s" : ""} attention</span>
          </Link>
        )}
        {stats && (
          <>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Bot className="h-3.5 w-3.5" />
              {stats.total_agents} agent{stats.total_agents !== 1 ? "s" : ""}
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {stats.pending_changes} pending
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <GitMerge className="h-3.5 w-3.5" />
              {stats.merged_changes} merged
            </span>
          </>
        )}
      </div>

      {/* Repo health cards */}
      {repos.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertCircle className="h-12 w-12 text-muted-foreground mb-4 opacity-40" />
            <h3 className="text-lg font-medium mb-1">No projects yet</h3>
            <p className="text-sm text-muted-foreground">
              Create a repository or push to get started
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {repos.map((repo) => {
            const health = computeRepoHealth(repo);
            const owner = repo.owner || "_";
            return (
              <Link key={repo.id} href={`/dashboard/repos/${owner}/${repo.name}`}>
                <Card className="bg-card border-border hover:border-primary/20 transition-colors cursor-pointer">
                  <CardContent className="flex items-center gap-4 py-4 px-5">
                    <HealthDot level={health} className="flex-shrink-0" />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">
                          {owner !== "_" ? `${owner}/` : ""}{repo.name}
                        </span>
                        {repo.has_conflicts && (
                          <Badge variant="outline" className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px]">
                            CONFLICT
                          </Badge>
                        )}
                      </div>
                      {repo.active_agent && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Bot className="h-3 w-3" />
                          {repo.active_agent} active
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-6 text-xs text-muted-foreground flex-shrink-0">
                      {(repo.escalated_count ?? 0) > 0 && (
                        <span className="text-yellow-400 font-medium">
                          {repo.escalated_count} escalated
                        </span>
                      )}
                      {(repo.pending_count ?? 0) > 0 && (
                        <span>{repo.pending_count} pending</span>
                      )}
                      {(repo.merged_count ?? 0) > 0 && (
                        <span>{repo.merged_count} merged</span>
                      )}
                      {repo.last_activity && (
                        <span>
                          {formatRelativeDate(repo.last_activity)}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}
