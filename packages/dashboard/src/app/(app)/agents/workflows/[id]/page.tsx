"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, type CiStatus, type WorkflowActivityEntry, type WorkflowRunDetail, type WorkflowTimelineEntry, type WorkflowRunProduced } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowLeft, CheckCircle2, GitBranch, XCircle, ChevronDown, ChevronRight } from "lucide-react";

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

function RawLogsView({ ns, repo, runId }: { ns: string; repo: string; runId: string }) {
  const [logs, setLogs] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const text = await api.getRawLogs(ns, repo, runId);
      setLogs(text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (logs !== null) {
    return (
      <div className="space-y-1.5 border-t border-border/60 pt-2">
        <div className="flex justify-between items-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span>Raw Logs</span>
          <button type="button" onClick={() => setLogs(null)} className="underline hover:text-foreground">Hide</button>
        </div>
        <pre className="p-3 max-h-96 overflow-auto rounded bg-muted/40 border border-border/60 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-all select-text">
          {logs || "No log content."}
        </pre>
      </div>
    );
  }

  return (
    <div className="border-t border-border/60 pt-2">
      <button type="button" onClick={fetchLogs} disabled={loading}
        className="text-[10px] font-medium uppercase tracking-wider underline text-muted-foreground hover:text-foreground">
        {loading ? "Loading logs..." : "View Raw Logs"}
      </button>
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
    </div>
  );
}

function RunDetail({ ns, repo, runId }: { ns: string; repo: string; runId: string }) {
  const [detail, setDetail] = useState<{ run: WorkflowRunDetail; timeline: WorkflowTimelineEntry[]; produced: WorkflowRunProduced } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [execOpen, setExecOpen] = useState(false);

  useEffect(() => {
    let live = true;
    api.getWorkflowRunV4(ns, repo, runId)
      .then(d => { if (live) setDetail(d); })
      .catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [ns, repo, runId]);

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!detail) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const steps = detail.run.stepResults ?? [];

  return (
    <div className="space-y-3 text-sm">
      <div className="border-t border-border/60 pt-2">
        <button type="button" onClick={() => setExecOpen(o => !o)} aria-expanded={execOpen}
          className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
          {execOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Execution details
        </button>
        {execOpen && (
          <div className="space-y-3 pt-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {detail.run.model && <span>model <code className="font-mono text-foreground">{detail.run.model}</code></span>}
              {detail.run.commit && <span>commit <code className="font-mono text-foreground">{detail.run.commit.slice(0, 8)}</code></span>}
              {detail.run.issue != null && <span>issue <code className="font-mono text-foreground">#{detail.run.issue}</code></span>}
            </div>
            <ul className="space-y-1">
              {detail.timeline.map((t, i) => (
                <li key={i} className="flex items-baseline gap-2 text-xs">
                  <span className="w-32 shrink-0 font-mono text-muted-foreground">
                    {t.at ? new Date(t.at).toLocaleTimeString() : "—"}
                  </span>
                  <span className="font-medium uppercase tracking-wider text-[10px] text-muted-foreground w-20 shrink-0">{t.kind}</span>
                  <span className="min-w-0 break-words text-muted-foreground">{t.detail ?? ""}</span>
                </li>
              ))}
            </ul>
            {steps.length > 0 && (
              <ul className="space-y-1 border-t border-border/60 pt-2">
                {steps.map((s, i) => (
                  <li key={i} className="text-xs text-muted-foreground">
                    <span className="font-mono text-foreground">{s.name ?? "step"}</span>
                    {s.status && <span className="ml-1 uppercase">· {s.status}</span>}
                    {s.note && <span className="block text-muted-foreground/80 whitespace-pre-wrap break-words">{s.note}</span>}
                  </li>
                ))}
              </ul>
            )}
            {detail.run.logUrl && (
              <RawLogsView ns={ns} repo={repo} runId={runId} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkflowActivityRunRow({ e }: { e: WorkflowActivityEntry }) {
  const [open, setOpen] = useState(false);
  const href = changeHref(e);
  const parts = e.repoName?.split("/");
  const ns = parts?.[0] ?? "";
  const repoName = parts?.[1] ?? "";

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="w-full flex flex-wrap items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/40">
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <StatusPill status={e.status} />
        {e.repoName && (
          <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <GitBranch className="h-3 w-3 text-muted-foreground" /> {e.repoName}
          </span>
        )}
        {e.task && (
          <span className="text-xs text-muted-foreground truncate min-w-0 flex-1 font-mono" title={e.task}>
            {e.task}
          </span>
        )}
        <span className="text-xs text-muted-foreground shrink-0">{new Date(e.createdAt).toLocaleString()}</span>
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1.5 bg-muted/10 border-t border-border/60 space-y-3">
          {e.terminalReason && e.status === "failure" && (
            <p className="text-xs text-destructive">{e.terminalReason}</p>
          )}

          {(e.produced.reviews.length > 0 || e.changeId) && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-full">Produced</div>
              {e.produced.reviews.map((r, i) => (
                <span key={i} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${r.verdict === "approve" ? "border-primary/30 text-primary bg-primary/5" : r.verdict === "request_changes" ? "border-destructive/30 text-destructive bg-destructive/5" : "border-border text-muted-foreground bg-muted/5"}`}>
                  {r.verdict === "approve" ? <CheckCircle2 className="h-3 w-3" /> : r.verdict === "request_changes" ? <XCircle className="h-3 w-3" /> : null}
                  review: {r.verdict.replace("_", " ")}
                  <span className="text-muted-foreground">· {new Date(r.submittedAt).toLocaleDateString()}</span>
                </span>
              ))}
              {e.changeId && (
                href
                  ? <Link href={href} className="text-xs text-primary hover:underline font-mono border border-primary/20 rounded px-2 py-0.5 bg-primary/5">change {e.changeId.slice(0, 8)} →</Link>
                  : <span className="text-xs text-muted-foreground font-mono border border-border rounded px-2 py-0.5">change {e.changeId.slice(0, 8)}</span>
              )}
            </div>
          )}

          {ns && repoName ? (
            <RunDetail ns={ns} repo={repoName} runId={e.id} />
          ) : (
            <p className="text-xs text-muted-foreground">Detail unavailable — the repo could not be resolved.</p>
          )}
        </div>
      )}
    </div>
  );
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
            {activity.map(e => (
              <WorkflowActivityRunRow key={e.id} e={e} />
            ))}
          </div>
        )}
    </div>
  );
}
