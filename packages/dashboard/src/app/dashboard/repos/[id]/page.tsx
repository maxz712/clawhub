"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ChangeCard } from "@/components/change-card";
import { FileBrowser } from "@/components/file-browser";
import { Loader2, GitFork, Shield, AlertCircle } from "lucide-react";

interface RepoInfo {
  id: string;
  name: string;
  description?: string;
  default_branch?: string;
  created_at?: string;
  owner_id?: string;
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
}

export default function RepoDetailPage() {
  const params = useParams();
  const repoId = params.id as string;

  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!repoId) return;

    Promise.all([
      api.getRepo(repoId).catch(() => null),
      api.getChanges(repoId).catch(() => []),
    ])
      .then(([repoData, changesData]) => {
        if (repoData) {
          const r = repoData.repo || repoData.repository || repoData;
          setRepo(r);
        }
        const items = Array.isArray(changesData)
          ? changesData
          : changesData.changes || [];
        setChanges(items);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [repoId]);

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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href="/dashboard/repos" className="hover:text-foreground">
              Repositories
            </Link>
            <span>/</span>
          </div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitFork className="h-6 w-6 text-muted-foreground" />
            {repo?.name || "Repository"}
          </h1>
          {repo?.description && (
            <p className="text-muted-foreground mt-1">{repo.description}</p>
          )}
        </div>

        <Link href={`/dashboard/repos/${repoId}/permissions`}>
          <Button variant="outline" size="sm">
            <Shield className="h-4 w-4 mr-2" />
            Permissions
          </Button>
        </Link>
      </div>

      <Tabs defaultValue="changes" className="w-full">
        <TabsList>
          <TabsTrigger value="changes">
            Changes ({changes.length})
          </TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
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
                  repoId={repoId}
                  change={change}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="files" className="mt-4">
          <FileBrowser repoId={repoId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
