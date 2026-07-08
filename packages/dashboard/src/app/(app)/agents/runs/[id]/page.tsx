"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, GitBranch, Bot, ChevronDown, ChevronRight, Check, AlertTriangle, MessageSquare } from "lucide-react";
import { api, type WorkflowRunDetail, type WorkflowTimelineEntry, type WorkflowRunProduced } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export default function AgentRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<{ run: WorkflowRunDetail; timeline: WorkflowTimelineEntry[]; produced: WorkflowRunProduced; repoNs: string; repoName: string } | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);

  useEffect(() => {
    let live = true;
    api.getMyWorkflowRunDetail(id)
      .then(d => { if (live) setDetail(d); })
      .catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    if (!detail) return;
    let live = true;
    setLoadingLogs(true);
    api.getRawLogs(detail.repoNs, detail.repoName, id)
      .then(text => { if (live) setLogs(text); })
      .catch(e => { if (live) console.error("Failed to load logs", e); })
      .finally(() => { if (live) setLoadingLogs(false); });
    return () => { live = false; };
  }, [detail, id]);

  if (error) return <Alert variant="destructive" className="m-6"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!detail) return <div className="p-6 text-muted-foreground">Loading run details…</div>;

  const run = detail.run;
  const steps = run.stepResults ?? [];
  const produced = detail.produced ?? { reviews: [], changeId: null };
  const changeId = produced.changeId ?? run.changeId;
  const producedNothing = produced.reviews.length === 0 && !changeId;

  return (
    <div className="space-y-6 max-w-6xl mx-auto p-6">
      <div>
        <Link href="/agents/runs" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Agent Runs
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Agent Run Details</h1>
          <Badge variant={run.status === "success" ? "default" : run.status === "failure" ? "destructive" : "secondary"}>
            {run.status}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground font-mono flex items-center gap-1">
          <GitBranch className="h-3.5 w-3.5" /> {detail.repoNs}/{detail.repoName} · run ID: {id}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1 space-y-4">
          <div className="rounded-lg border bg-card p-4 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Metadata</h2>
            <div className="space-y-1.5 text-xs">
              {run.model && <p className="text-muted-foreground font-mono">Model: <span className="text-foreground">{run.model}</span></p>}
              {run.commit && <p className="text-muted-foreground font-mono">Commit: <span className="text-foreground">{run.commit.slice(0, 8)}</span></p>}
              {run.issue != null && <p className="text-muted-foreground font-mono">Issue: <span className="text-foreground">#{run.issue}</span></p>}
              {run.finishedAt && <p className="text-muted-foreground font-mono">Finished: <span className="text-foreground">{new Date(run.finishedAt).toLocaleString()}</span></p>}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Execution Timeline</h2>
            <ul className="space-y-2">
              {detail.timeline.map((t, i) => (
                <li key={i} className="flex items-baseline gap-2 text-xs">
                  <span className="w-16 shrink-0 font-mono text-muted-foreground">
                    {t.at ? new Date(t.at).toLocaleTimeString() : "—"}
                  </span>
                  <div>
                    <span className="font-semibold uppercase tracking-wider text-[10px] text-muted-foreground block">{t.kind}</span>
                    <span className="text-muted-foreground break-words">{t.detail ?? ""}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="md:col-span-2 space-y-6">
          {!producedNothing && (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Produced</h2>
              <div className="flex flex-wrap items-center gap-2">
                {produced.reviews.map((r, i) => {
                  const style =
                    r.verdict === "approve"
                      ? { Icon: Check, label: "approved", cls: "text-primary border-primary/40 bg-primary/10" }
                      : r.verdict === "request_changes"
                        ? { Icon: AlertTriangle, label: "changes requested", cls: "text-amber-300 border-amber-400/40 bg-amber-400/10" }
                        : { Icon: MessageSquare, label: r.verdict.replace("_", " "), cls: "text-sky-300 border-sky-400/40 bg-sky-400/10" };
                  return (
                    <span key={i} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${style.cls}`}>
                      <style.Icon className="h-3 w-3" /> {style.label}{r.basis ? ` (${r.basis})` : ""}
                    </span>
                  );
                })}
                {changeId && (
                  <Link href={`/repos/${detail.repoNs}/${detail.repoName}/changes/${changeId}`}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent transition-colors">
                    Change →
                  </Link>
                )}
              </div>
            </div>
          )}

          {steps.length > 0 && (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Steps</h2>
              <ul className="space-y-2">
                {steps.map((s, i) => (
                  <li key={i} className="text-xs text-muted-foreground border-b border-border/40 pb-2 last:border-0 last:pb-0">
                    <div className="flex justify-between items-center">
                      <span className="font-mono text-foreground font-semibold">{s.name ?? "step"}</span>
                      {s.status && <Badge variant="secondary" className="text-[9px] uppercase">{s.status}</Badge>}
                    </div>
                    {s.note && <span className="block mt-1 text-muted-foreground/80 whitespace-pre-wrap break-words">{s.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-lg border bg-card p-4 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex justify-between items-center">
              <span>Raw Execution Logs</span>
              {loadingLogs && <span className="text-[10px] lowercase animate-pulse text-muted-foreground">Loading…</span>}
            </h2>
            <pre className="p-4 max-h-[600px] overflow-auto rounded bg-muted/40 border border-border/60 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-all select-text">
              {logs || (loadingLogs ? "Loading logs content..." : "No logs available.")}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
