"use client";

import { useCallback, useEffect, useState, use } from "react";
import { api, type CiPipeline } from "@/lib/api";
import { PipelineEditor } from "@/components/pipeline-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RotateCw } from "lucide-react";

// CI is a first-class repo surface (peer of Code/Changes/Issues), not a
// settings pane — you look at runs far more often than you edit pipelines.
// PipelineEditor already carries the whole surface: recent runs, the runner
// onboarding explainer, and the pipeline YAML editor (writes are
// server-gated; read-only callers simply can't save).
export default function RepoCiPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [pipelines, setPipelines] = useState<CiPipeline[]>([]);
  const [error, setError] = useState<string | null>(null);
  // ?run=<id> deep-link (from a Change's CI row): scroll to + highlight that
  // run in the runs list. Read via window.location so the client page needs no
  // useSearchParams Suspense boundary.
  const [highlightRunId, setHighlightRunId] = useState<string | null>(null);
  useEffect(() => {
    setHighlightRunId(new URLSearchParams(window.location.search).get("run"));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try { const p = await api.listPipelines(ns, repo); setPipelines(p.pipelines); }
    catch (e) { setError((e as Error).message); }
  }, [ns, repo]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">CI</h1>
        <p className="text-sm text-muted-foreground mt-1">Pipelines and their runs. Four triggers: push, merge, schedule, event.</p>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>Couldn&apos;t load CI: {error}</span>
            <Button variant="outline" size="sm" className="gap-2 shrink-0" onClick={() => void load()}>
              <RotateCw className="h-4 w-4" /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <PipelineEditor ns={ns} repo={repo} pipelines={pipelines} onChange={load} highlightRunId={highlightRunId} />
      )}
    </div>
  );
}
