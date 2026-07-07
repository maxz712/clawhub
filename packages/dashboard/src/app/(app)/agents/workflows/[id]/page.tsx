"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, type CiStatus, type WorkflowActivityEntry } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowLeft, CheckCircle2, GitBranch, XCircle } from "lucide-react";

// One workflow's activity (v4): every run it dispatched, leading with what the
// run PRODUCED (reviews submitted, the Change it worked) — an agent run is
// real activity, not a CI log line.

const STATUS_STYLE: Record<CiStatus, string> = {
  pending: "bg-muted text-muted-foreground border-border",
  running: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  success: "bg-primary/15 text-primary border-primary/30",
  failure: "bg-destructive/15 text-destructive border-destructive/30",
  skipped: "bg-muted text-muted-foreground border-border",
};

function StatusPill({ status }: { status: CiStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STATUS_STYLE[status] ?? STATUS_STYLE.pending}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === "running" ? "animate-pulse bg-blue-400" : status === "success" ? "bg-primary" : status === "failure" ? "bg-destructive" : "bg-muted-foreground"}`} />
      {status}
    </span>
  );
}

// repoName may or may not carry its namespace — only compose a change link
// when it does (ns/name); otherwise show the change id unlinked.
function changeHref(e: WorkflowActivityEntry): string | null {
  if (!e.changeId || !e.repoName || !e.repoName.includes("/")) return null;
  return `/repos/${e.repoName}/changes/${e.changeId}`;
}

export default function WorkflowActivityPage() {
  const { id } = useParams<{ id: string }>();
  const [workflow, setWorkflow] = useState<{ id: string; name: string; instructions: string; trigger: string } | null>(null);
  const [activity, setActivity] = useState<WorkflowActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.getWorkflowActivity(id)
      .then(r => { setWorkflow(r.workflow); setActivity(r.activity); })
      .catch(e => setError((e as Error).message));
  }, [id]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/agents/workflows" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Workflows
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-bold tracking-tight">{workflow?.name ?? "Workflow"}</h1>
          {workflow && <Badge variant="secondary" className="text-[10px]">{workflow.trigger}</Badge>}
        </div>
        {workflow?.instructions && (
          <p className="mt-1.5 text-xs text-muted-foreground font-mono whitespace-pre-wrap">{workflow.instructions}</p>
        )}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {!activity ? <div className="text-muted-foreground">Loading…</div>
        : activity.length === 0 ? (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            No runs yet. Use <strong>Run now</strong> on the Workflows tab — or wait for its trigger.
          </div>
        ) : (
          <div className="space-y-2">
            {activity.map(e => {
              const href = changeHref(e);
              return (
                <div key={e.id} className="rounded-lg border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={e.status} />
                    {e.repoName && (
                      <span className="inline-flex items-center gap-1 font-mono text-xs">
                        <GitBranch className="h-3 w-3 text-muted-foreground" /> {e.repoName}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
                  </div>
                  {e.task && <p className="mt-1.5 text-xs text-muted-foreground font-mono truncate" title={e.task}>{e.task}</p>}
                  {e.terminalReason && e.status === "failure" && (
                    <p className="mt-1 text-xs text-destructive">{e.terminalReason}</p>
                  )}
                  {/* What the run PRODUCED — reviews + the Change it worked. */}
                  {(e.produced.reviews.length > 0 || e.changeId) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
                      {e.produced.reviews.map((r, i) => (
                        <span key={i} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${r.verdict === "approve" ? "border-primary/30 text-primary" : r.verdict === "request_changes" ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"}`}>
                          {r.verdict === "approve" ? <CheckCircle2 className="h-3 w-3" /> : r.verdict === "request_changes" ? <XCircle className="h-3 w-3" /> : null}
                          review: {r.verdict.replace("_", " ")}
                          <span className="text-muted-foreground">· {new Date(r.submittedAt).toLocaleDateString()}</span>
                        </span>
                      ))}
                      {e.changeId && (
                        href
                          ? <Link href={href} className="text-xs text-primary hover:underline font-mono">change {e.changeId.slice(0, 8)}</Link>
                          : <span className="text-xs text-muted-foreground font-mono">change {e.changeId.slice(0, 8)}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
