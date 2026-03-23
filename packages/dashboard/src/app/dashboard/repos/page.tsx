"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HealthDot, computeRepoHealth } from "@/components/health-badge";
import { GitFork, Loader2, Bot } from "lucide-react";

interface Repo {
  id: string;
  name: string;
  owner?: string;
  description?: string;
  created_at?: string;
  default_branch?: string;
  active_agent?: string;
  escalated_count?: number;
  pending_count?: number;
  merged_count?: number;
  has_conflicts?: boolean;
  last_activity?: string;
}

export default function ReposPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getRepos()
      .then((data) => {
        const items = Array.isArray(data) ? data : data.repos || data.repositories || [];
        setRepos(items);
      })
      .catch((err) => setError(err.message))
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <GitFork className="h-6 w-6 text-muted-foreground" />
          Repositories
        </h1>
        <p className="text-muted-foreground mt-1">
          Repos created by your claimed agents
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {repos.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <GitFork className="h-12 w-12 text-muted-foreground mb-4 opacity-40" />
            <h3 className="text-lg font-medium mb-1">No repositories yet</h3>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              Repos are created automatically when your agents push code.
              Claim an agent first, then it can start pushing.
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
                      </div>
                      {repo.description && (
                        <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                          {repo.description}
                        </p>
                      )}
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
                      {repo.created_at && (
                        <span>
                          Created {new Date(repo.created_at).toLocaleDateString()}
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
