"use client";

import { useCallback, useEffect, useState, use } from "react";
import { api, type WorkflowRun } from "@/lib/api";
import { WorkflowRunsTable } from "@/components/workflow-runs-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RotateCw } from "lucide-react";

// v3 P4 — the repo Runs tab: agent-origin workflow runs as a first-class
// surface, decoupled from CI in the UI (peer tab of CI, not a pane inside it).
export default function RepoWorkflowRunsPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { const r = await api.listWorkflowRuns(ns, repo); setRuns(r.runs); }
    catch (e) { setError((e as Error).message); }
  }, [ns, repo]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Runs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Workflow runs — agents working this repo, whoever asked: schedules, triggers, Run now, or a slash command in a thread.
            Runs produce activity — reviews, Changes; execution is plumbing.
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-2 shrink-0" onClick={() => void load()}>
          <RotateCw className="h-4 w-4" /> Refresh
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>Couldn&apos;t load runs: {error}</span>
            <Button variant="outline" size="sm" className="gap-2 shrink-0" onClick={() => void load()}>
              <RotateCw className="h-4 w-4" /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : runs === null ? (
        <div className="text-muted-foreground">Loading…</div>
      ) : (
        <WorkflowRunsTable runs={runs} repoOf={() => ({ ns, repo })} />
      )}
    </div>
  );
}
