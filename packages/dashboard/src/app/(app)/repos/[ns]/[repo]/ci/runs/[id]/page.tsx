"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, GitBranch, Bot, ChevronDown, ChevronRight, Check, AlertTriangle, MessageSquare } from "lucide-react";
import { api, type WorkflowRunDetail, type WorkflowTimelineEntry, type WorkflowRunProduced } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

// Poll cadence while a run is still going — matches the runner's log-flush
// interval closely enough that a fresh chunk shows up within a beat or two.
const POLL_MS = 3000;

export default function CiRunDetailPage({ params }: { params: Promise<{ ns: string; repo: string; id: string }> }) {
  const { ns, repo, id } = use(params);
  const [detail, setDetail] = useState<{ run: WorkflowRunDetail; timeline: WorkflowTimelineEntry[]; produced: WorkflowRunProduced } | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const logsPreRef = useRef<HTMLPreElement>(null);
  // Only auto-scroll while the reader is already at (or near) the bottom —
  // scrolling up to read something earlier shouldn't get yanked back down
  // by the next poll.
  const stickToBottomRef = useRef(true);
  const running = detail?.run.status === "running";

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = () => {
      api.getCiRun(ns, repo, id)
        .then(d => {
          if (!live) return;
          setDetail(d);
          // Keep polling run status while it's active, so this page notices
          // the terminal transition (and stops both polling loops) on its own.
          if (d.run.status === "running" || d.run.status === "pending") timer = setTimeout(load, POLL_MS);
        })
        .catch(e => { if (live) setError((e as Error).message); });
    };
    load();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [ns, repo, id]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoadingLogs(true);

    const load = () => {
      api.getRawLogs(ns, repo, id)
        .then(text => { if (live) setLogs(text); })
        .catch(e => {
          // The runner hasn't flushed any output yet (early in the run) — not
          // a real error, just nothing to show yet.
          if (live && !/404|not found|not uploaded/i.test((e as Error).message)) console.error("Failed to load logs", e);
        })
        .finally(() => {
          if (!live) return;
          setLoadingLogs(false);
          if (running) timer = setTimeout(load, POLL_MS);
        });
    };
    load();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [ns, repo, id, running]);

  // Auto-scroll to the newest log content, but only when the reader hasn't
  // scrolled away from the bottom to read something earlier.
  useEffect(() => {
    const el = logsPreRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

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
        <Link href={`/repos/${ns}/${repo}/ci`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to CI
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">CI Run Details</h1>
          <Badge variant={run.status === "success" ? "default" : run.status === "failure" ? "destructive" : "secondary"}>
            {run.status}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground font-mono flex items-center gap-1">
          <GitBranch className="h-3.5 w-3.5" /> {ns}/{repo} · run ID: {id}
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
                  <Link href={`/repos/${ns}/${repo}/changes/${changeId}`}
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
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <span>Raw Execution Logs</span>
              {running && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-blue-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" /> live
                </span>
              )}
              <span className="flex-1" />
              {loadingLogs && <span className="text-[10px] lowercase animate-pulse text-muted-foreground">Loading…</span>}
            </h2>
            <pre
              ref={logsPreRef}
              onScroll={e => {
                const el = e.currentTarget;
                stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              }}
              className="p-4 max-h-[600px] overflow-auto rounded bg-muted/40 border border-border/60 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-all select-text"
            >
              {logs || (loadingLogs ? "Loading logs content..." : running ? "Waiting for output…" : "No logs available.")}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
