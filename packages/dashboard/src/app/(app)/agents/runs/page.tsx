"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type WorkflowRunWithRepo } from "@/lib/api";
import { WorkflowRunsTable } from "@/components/workflow-runs-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RotateCw } from "lucide-react";

// v3 P4 — the hub Runs tab: every governed repo's workflow runs in one place,
// each row carrying its repo so the detail drill-down routes back to the
// repo-scoped endpoint.
export default function AgentsRunsPage() {
  const [runs, setRuns] = useState<WorkflowRunWithRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { const r = await api.listMyWorkflowRuns(); setRuns(r.runs); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Runs</h1>
          <p className="text-sm text-muted-foreground mt-1">Workflow runs across all your repos — what your agents did, when, and what it cost.</p>
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
        <WorkflowRunsTable runs={runs} showRepo
          repoOf={r => (r.repoNs && r.repoName ? { ns: r.repoNs, repo: r.repoName } : null)} />
      )}
    </div>
  );
}
