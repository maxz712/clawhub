"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type CiStatus, type WorkflowRun, type WorkflowRunDetail, type WorkflowRunProduced, type WorkflowTimelineEntry } from "@/lib/api";
import { formatRelativeTime, absoluteTime } from "@/lib/time";
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";

// v3 P4 — the Workflow Runs table, shared by the repo Runs tab and the Agents
// hub Runs tab. Rows are agent-origin runs (ci_runs under the hood); a row
// click expands an inline detail (timeline + step results), fetched lazily
// from the repo-scoped detail endpoint.

type RunRow = WorkflowRun & { repoNs?: string | null; repoName?: string | null };

/** Metered platform cost as dollars; BYO runs (0) render nothing. */
function costLabel(microUsd: number): string | null {
  if (!microUsd || microUsd <= 0) return null;
  return microUsd < 10_000 ? "<$0.01" : `$${(microUsd / 1_000_000).toFixed(2)}`;
}

// Same palette as CiStatusPill, without the "ci:" prefix (this is a workflow
// surface) and WITH a "skipped" pill (here it means coalesced-away, not
// "no CI configured").
const STATUS_STYLES: Record<CiStatus, string> = {
  pending: "bg-muted text-muted-foreground border-border",
  running: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  success: "bg-primary/15 text-primary border-primary/30",
  failure: "bg-destructive/15 text-destructive border-destructive/30",
  skipped: "bg-muted text-muted-foreground border-border",
};

function StatusPill({ status }: { status: WorkflowRun["status"] }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STATUS_STYLES[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === "running" ? "animate-pulse" : ""} ${
        status === "running" ? "bg-blue-400"
          : status === "success" ? "bg-primary"
          : status === "failure" ? "bg-destructive"
          : "bg-muted-foreground"
      }`} />
      {status}
    </span>
  );
}

/** A produced review verdict as a chip: "✓ approved (code)". */
function ProducedReviewChip({ verdict, basis }: { verdict: string; basis: string }) {
  const style =
    verdict === "approve"
      ? { Icon: Check, label: "approved", cls: "text-primary border-primary/40 bg-primary/10" }
      : verdict === "request_changes"
        ? { Icon: AlertTriangle, label: "changes requested", cls: "text-amber-300 border-amber-400/40 bg-amber-400/10" }
        : { Icon: MessageSquare, label: verdict.replace("_", " "), cls: "text-sky-300 border-sky-400/40 bg-sky-400/10" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${style.cls}`}>
      <style.Icon className="h-3 w-3" /> {style.label}{basis ? ` (${basis})` : ""}
    </span>
  );
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

// v4 — a run's detail LEADS with what it PRODUCED (reviews submitted, the
// Change it worked): runs produce activity — reviews, Changes; execution is
// plumbing, demoted to a collapsed "Execution details" disclosure.
function Detail({ ns, repo, run }: { ns: string; repo: string; run: RunRow }) {
  const [detail, setDetail] = useState<{ run: WorkflowRunDetail; timeline: WorkflowTimelineEntry[]; produced: WorkflowRunProduced } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [execOpen, setExecOpen] = useState(false);

  // Fetched when the row expands (this component only mounts then).
  useEffect(() => {
    let live = true;
    api.getWorkflowRunV4(ns, repo, run.id)
      .then(d => { if (live) setDetail(d); })
      .catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [ns, repo, run.id]);

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!detail) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const steps = detail.run.stepResults ?? [];
  const produced = detail.produced ?? { reviews: [], changeId: null };
  const changeId = produced.changeId ?? detail.run.changeId;
  const producedNothing = produced.reviews.length === 0 && !changeId;

  return (
    <div className="space-y-3 text-sm">
      {/* Produced — the run's artifacts lead. */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Produced</div>
        {producedNothing ? (
          <p className="text-xs text-muted-foreground">
            Nothing yet — runs produce activity (reviews, Changes); execution is plumbing.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {produced.reviews.map((r, i) => <ProducedReviewChip key={i} verdict={r.verdict} basis={r.basis} />)}
            {changeId && (
              <Link href={`/repos/${ns}/${repo}/changes/${changeId}`}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent transition-colors">
                Change →
              </Link>
            )}
          </div>
        )}
      </div>

      {run.task && <p className="text-xs whitespace-pre-wrap break-words rounded bg-muted/30 border border-border/60 px-2.5 py-1.5 font-mono">{run.task}</p>}

      {/* Execution details — timeline + steps + logs, collapsed by default. */}
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
              {detail.run.logUrl && (
                <a href={detail.run.logUrl} target="_blank" rel="noreferrer" className="font-mono underline hover:text-foreground">logs</a>
              )}
            </div>
            {/* Timeline: dispatched → started → steps → terminal. */}
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
              <RawLogsView ns={ns} repo={repo} runId={run.id} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowRunsTable({ runs, repoOf, showRepo = false }: {
  runs: RunRow[];
  /** Resolve a row to its repo (ns + name) — null when unknown (detail fetch skipped). */
  repoOf: (run: RunRow) => { ns: string; repo: string } | null;
  /** Show a repo column (the cross-repo hub view). */
  showRepo?: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (runs.length === 0) {
    return (
      <div className="p-6 rounded-lg border bg-card text-sm text-muted-foreground">
        No workflow runs yet. Deploy an agent in the Agents hub, or dispatch one from a Change/Issue comment with a slash command (<code className="font-mono">/dev</code>, <code className="font-mono">/review</code>, <code className="font-mono">/verify</code>, …).
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card divide-y divide-border overflow-hidden">
      {runs.map(run => {
        const target = repoOf(run);
        const open = openId === run.id;
        const cost = costLabel(run.costMicroUsd);
        const agent = run.workflowAgent;
        return (
          <div key={run.id}>
            <button type="button" onClick={() => setOpenId(open ? null : run.id)} aria-expanded={open}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent/40">
              {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <StatusPill status={run.status} />
              {showRepo && (
                <span className="font-mono text-xs text-muted-foreground truncate max-w-[14rem] shrink-0">
                  {run.repoNs && run.repoName ? `${run.repoNs}/${run.repoName}` : "—"}
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-sm shrink-0">
                <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                <code className="font-mono text-xs">@{agent?.agentName ?? agent?.name ?? "agent"}</code>
              </span>
              {run.mode && (
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0">
                  {run.mode}
                </span>
              )}
              <span className="text-xs text-muted-foreground truncate min-w-0 flex-1" title={run.task ?? undefined}>
                {run.task ?? ""}
              </span>
              {run.triggeredBy && (
                <span className="text-xs text-muted-foreground shrink-0">by <code className="font-mono">@{run.triggeredBy}</code></span>
              )}
              {cost && <span className="text-xs font-mono text-muted-foreground shrink-0">{cost}</span>}
              <span className="text-xs text-muted-foreground shrink-0" title={absoluteTime(run.createdAt)}>{formatRelativeTime(run.createdAt)}</span>
            </button>
            {open && (
              <div className="px-4 pb-3 pt-1 bg-muted/10 border-t border-border/60">
                {target
                  ? <Detail ns={target.ns} repo={target.repo} run={run} />
                  : <p className="text-xs text-muted-foreground">Detail unavailable — the repo could not be resolved.</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
