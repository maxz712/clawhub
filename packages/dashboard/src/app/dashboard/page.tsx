"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatCard } from "@/components/stat-card";
import { ActivityFeed } from "@/components/activity-feed";
import { GitFork, Bot, Clock, GitMerge, Loader2 } from "lucide-react";

interface DashboardStats {
  total_repos: number;
  total_agents: number;
  pending_changes: number;
  merged_changes: number;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getStats()
      .then((data) => setStats(data.stats || data))
      .catch(() => {
        // Stats might not be available yet
        setStats({
          total_repos: 0,
          total_agents: 0,
          pending_changes: 0,
          merged_changes: 0,
        });
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          Overview of your AI code supervision platform
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Repositories"
          value={stats?.total_repos ?? 0}
          icon={GitFork}
          description="Active repositories"
        />
        <StatCard
          title="Agents"
          value={stats?.total_agents ?? 0}
          icon={Bot}
          description="Registered AI agents"
        />
        <StatCard
          title="Pending Changes"
          value={stats?.pending_changes ?? 0}
          icon={Clock}
          description="Awaiting review"
        />
        <StatCard
          title="Merged Changes"
          value={stats?.merged_changes ?? 0}
          icon={GitMerge}
          description="Successfully merged"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ActivityFeed />
      </div>
    </div>
  );
}
