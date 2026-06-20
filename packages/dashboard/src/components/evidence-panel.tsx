"use client";

import { useEffect, useState } from "react";
import {
  api, effectiveRisk,
  type Change, type CiArtifact, type CiRun, type MergeDecision, type Review, type Risk,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { ReviewBasisChip } from "@/components/review-basis-chip";
import { humanizeMergeReason } from "@/lib/merge-reason";
import { Target, ShieldAlert, FlaskConical, Users, Paperclip } from "lucide-react";

const RISK_STYLES: Record<Risk, string> = {
  low: "bg-primary/15 text-primary border-primary/30",
  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  critical: "bg-destructive/15 text-destructive border-destructive/30",
};

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {icon}{title}
      </div>
      {children}
    </div>
  );
}

/**
 * Evidence-first summary shown above the diff. ClawHub verifies most changes by
 * OUTCOME (CI green, behavior confirmed) rather than by reading code, so this
 * panel leads with intent, the EFFECTIVE risk + the explainable reasons behind
 * it, CI runs + artifacts, and reviewer verdicts with their basis.
 */
export function EvidencePanel({
  ns, repo, change, mergeable, reviews,
}: {
  ns: string; repo: string; change: Change; mergeable: MergeDecision; reviews: Review[];
}) {
  const [runs, setRuns] = useState<CiRun[] | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, CiArtifact[]>>({});

  useEffect(() => {
    let live = true;
    api.listCiRuns(ns, repo, change.id)
      .then(async ({ runs }) => {
        if (!live) return;
        setRuns(runs);
        // Pull artifacts for terminal runs so reviewers can inspect the outcome
        // (test reports, build output) without leaving the page.
        const byRun: Record<string, CiArtifact[]> = {};
        await Promise.all(runs.map(async r => {
          const a = await api.listArtifacts(ns, repo, r.id).catch(() => ({ artifacts: [] as CiArtifact[] }));
          if (a.artifacts.length) byRun[r.id] = a.artifacts;
        }));
        if (live) setArtifacts(byRun);
      })
      .catch(() => { if (live) setRuns([]); });
    return () => { live = false; };
  }, [ns, repo, change.id]);

  const effRisk = effectiveRisk(change);
  const riskEscalated = change.computedRisk != null && change.computedRisk !== change.risk;
  const reasons = change.riskReasons ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base leading-snug">{change.intent || "(no intent declared)"}</CardTitle>
        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
          <span className="font-mono">{change.branch}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Effective risk + explainability — the trust mechanism, shown not hidden. */}
        <Section icon={<ShieldAlert className="h-3.5 w-3.5" />} title="Risk">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${RISK_STYLES[effRisk]}`}>
              {effRisk}
            </span>
            {riskEscalated && (
              <span className="text-[11px] text-muted-foreground">
                computed from the diff · agent declared <span className="uppercase">{change.risk}</span>
              </span>
            )}
            {change.computedRisk == null && (
              <span className="text-[11px] text-muted-foreground">agent-declared</span>
            )}
          </div>
          {reasons.length > 0 ? (
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {reasons.map((r, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-muted-foreground/60 select-none">•</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No risk signals flagged.</p>
          )}
        </Section>

        {/* CI — outcome-based evidence. */}
        <Section icon={<FlaskConical className="h-3.5 w-3.5" />} title="CI">
          {runs === null ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : runs.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CiStatusPill status={change.ciStatus} />
              {change.ciStatus === "skipped" && <span>No pipelines configured.</span>}
            </div>
          ) : (
            <ul className="space-y-2">
              {runs.map(run => (
                <li key={run.id} className="rounded border border-border bg-muted/30 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <CiStatusPill status={run.status} />
                    {run.logUrl && (
                      <a href={run.logUrl} target="_blank" rel="noreferrer" className="text-[11px] font-mono underline text-muted-foreground hover:text-foreground">logs</a>
                    )}
                  </div>
                  {artifacts[run.id]?.length ? (
                    <ul className="mt-1.5 space-y-1">
                      {artifacts[run.id].map(a => (
                        <li key={a.id}>
                          <a href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-mono text-primary hover:underline">
                            <Paperclip className="h-3 w-3" />{a.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Reviewer verdicts, each tagged with what it rests on. */}
        <Section icon={<Users className="h-3.5 w-3.5" />} title={`Reviews (${reviews.length})`}>
          {reviews.length === 0 ? (
            <p className="text-xs text-muted-foreground">No reviews yet.</p>
          ) : (
            <ul className="space-y-2">
              {reviews.map(r => (
                <li key={r.id} className="border-l-2 border-border pl-3 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant={r.verdict === "approve" ? "default" : r.verdict === "request_changes" ? "destructive" : "secondary"}
                      className="text-[10px] uppercase"
                    >
                      {r.verdict.replace("_", " ")}
                    </Badge>
                    <ReviewBasisChip basis={r.basis ?? "code"} />
                    <code className="text-[11px] font-mono text-muted-foreground">{r.reviewerKind}</code>
                  </div>
                  {r.summary && <p className="mt-1 text-xs text-muted-foreground">{r.summary}</p>}
                  {r.evidence && r.evidence.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {r.evidence.map(e => (
                        <div key={e.id} className="rounded border border-border/60 bg-muted/30 p-2">
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{e.label || e.kind.replace("_", " ")}</div>
                          {e.content && <pre className="text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-auto">{e.content}</pre>}
                          {e.url && e.kind === "screenshot" && <a href={e.url} target="_blank" rel="noreferrer"><img src={e.url} alt={e.label || "screenshot"} className="rounded border border-border max-h-64" /></a>}
                          {e.url && e.kind !== "screenshot" && <a href={e.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline break-all">{e.url}</a>}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Scope + review-focus pointers. */}
        {change.scope.length > 0 && (
          <Section icon={<Target className="h-3.5 w-3.5" />} title="Scope">
            <div className="flex flex-wrap gap-1">
              {change.scope.map(s => <code key={s} className="text-xs px-1.5 py-0.5 rounded bg-muted">{s}</code>)}
            </div>
          </Section>
        )}

        {/* Merge readiness, surfacing needs_code_review explicitly. */}
        <div className="pt-1 border-t border-border">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1 mt-3">Merge</div>
          {mergeable.mergeable ? (
            <div className="text-sm text-primary">Ready to merge</div>
          ) : mergeable.reason === "needs_code_review" ? (
            <div className="text-sm text-orange-400">
              Needs a code-level review
              <span className="block text-xs text-muted-foreground">High risk or a sensitive path — behavior verification alone won&apos;t unblock this.</span>
            </div>
          ) : (
            <div className="text-sm">
              <span className="text-yellow-400">Blocked</span>
              <span className="block text-xs text-muted-foreground mt-0.5">{humanizeMergeReason(mergeable.reason)}</span>
              {(mergeable.reason === "needs_human_approval" || mergeable.reason === "needs_more_approvals") && (
                <span className="block text-xs text-muted-foreground mt-1">
                  You&apos;re the supervisor — it&apos;s fine to approve your own agent&apos;s work below as the human.
                  {mergeable.reason === "needs_human_approval" && (
                    <> Solo owner? Turn on <span className="font-medium text-foreground">Solo mode</span> in repo Settings to let your own approval count on low/medium changes (sensitive-path + high-risk still need a human code review).</>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
