"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ChangeCard } from "@/components/change-card";
import { FileBrowser } from "@/components/file-browser";
import { HealthBadge, computeRepoHealth } from "@/components/health-badge";
import { Loader2, GitFork, AlertCircle, Copy, GitCommit, Check, Bot, Clock } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface RepoInfo {
  id: string;
  name: string;
  owner?: string;
  description?: string;
  default_branch?: string;
  created_at?: string;
  owner_id?: string;
  git_path?: string;
  active_agent?: string;
  escalated_count?: number;
  pending_count?: number;
  merged_count?: number;
  has_conflicts?: boolean;
}

interface Change {
  id: string;
  title?: string;
  description?: string;
  status: string;
  risk_level?: string;
  agent_name?: string;
  created_at?: string;
  intent?: { description?: string };
  has_conflicts?: boolean;
}

interface Commit {
  hash: string;
  message: string;
  author?: string;
  date?: string;
}

export default function RepoDetailPage() {
  const params = useParams();
  const ownerParam = params.owner as string;
  const repoParam = params.repo as string;
  const repoPath = `${ownerParam}/${repoParam}`;

  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!ownerParam || !repoParam) return;

    Promise.all([
      api.getRepo(repoPath).catch(() => null),
      api.getChanges(repoPath).catch(() => ({ changes: [] })),
      api.getCommits(repoPath).catch(() => ({ commits: [] })),
    ])
      .then(([repoData, changesData, commitsData]) => {
        if (repoData) {
          const r = (repoData as Record<string, unknown>).repository || (repoData as Record<string, unknown>).repo || repoData;
          setRepo(r as RepoInfo);
        }
        const changeItems = Array.isArray(changesData)
          ? changesData
          : (changesData as Record<string, unknown>).changes || [];
        setChanges(changeItems as Change[]);
        const commitItems = Array.isArray(commitsData)
          ? commitsData
          : (commitsData as Record<string, unknown>).commits || [];
        setCommits(commitItems as Commit[]);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [ownerParam, repoParam, repoPath]);

  const cloneUrl = `${API_BASE}/${ownerParam}/${repoParam}.git`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`git clone ${cloneUrl}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <AlertCircle className="h-8 w-8 text-destructive mb-2" />
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  const health = repo ? computeRepoHealth(repo) : "green";
  const defaultBranch = repo?.default_branch || "main";

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/dashboard/repos" className="hover:text-foreground">
          Repositories
        </Link>
        <span>/</span>
        <span className="text-foreground">{ownerParam}/{repoParam}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitFork className="h-6 w-6 text-muted-foreground" />
            {ownerParam}/{repoParam}
          </h1>
          {repo?.description && (
            <p className="text-muted-foreground mt-1">{repo.description}</p>
          )}
          <div className="flex items-center gap-3 mt-2">
            <HealthBadge level={health} />
            {repo?.active_agent && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Bot className="h-3 w-3" />
                {repo.active_agent} active
              </span>
            )}
            {repo?.created_at && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Created {new Date(repo.created_at).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Clone URL */}
      <Card className="bg-card border-border">
        <CardContent className="flex items-center gap-3 py-3">
          <span className="text-sm text-muted-foreground whitespace-nowrap">Clone:</span>
          <code className="flex-1 text-sm font-mono bg-muted/30 px-3 py-1.5 rounded overflow-x-auto">
            git clone {cloneUrl}
          </code>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 flex-shrink-0"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-400" />
            ) : (
              <Copy className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </CardContent>
      </Card>

      <Tabs defaultValue="changes" className="w-full">
        <TabsList>
          <TabsTrigger value="changes">
            Changes ({changes.length})
          </TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="commits">
            Commits ({commits.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="changes" className="mt-4">
          {changes.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <AlertCircle className="h-8 w-8 text-muted-foreground mb-2 opacity-40" />
                <p className="text-muted-foreground text-sm">
                  No changes submitted yet
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {changes.map((change) => (
                <ChangeCard
                  key={change.id}
                  repoId={repoPath}
                  owner={ownerParam}
                  repoName={repoParam}
                  change={change}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="files" className="mt-4">
          <FileBrowser repoId={repoPath} branch={defaultBranch} />
        </TabsContent>

        <TabsContent value="commits" className="mt-4">
          {commits.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <GitCommit className="h-8 w-8 text-muted-foreground mb-2 opacity-40" />
                <p className="text-muted-foreground text-sm">
                  No commits yet
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card className="bg-card border-border">
              <CardContent className="divide-y divide-border pt-4">
                {commits.map((commit, i) => (
                  <div key={commit.hash || i} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {commit.message}
                        </p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span className="font-mono">
                            {commit.hash?.slice(0, 7)}
                          </span>
                          {commit.author && <span>{commit.author}</span>}
                        </div>
                      </div>
                      {commit.date && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(commit.date).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
