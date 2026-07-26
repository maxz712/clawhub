"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { effectiveRisk, type Change, type CiRun, type Review, type ReviewFocus, type VerificationRun } from "@/lib/api";
import { RiskBadge } from "@/components/risk-badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { ReviewBriefCard } from "@/components/review-brief";
import { AdvisoryReviewCard } from "@/components/advisory-review-card";
import { VerificationPanel } from "@/components/verification-panel";
import { ReviewVerdictsList } from "@/components/evidence-panel";
import { relativeTime } from "@/lib/cron";
import {
  AlertTriangle, Bot, ChevronDown, ChevronRight, Flag, FlaskConical,
  MessageSquare, ShieldAlert, ShieldCheck, Target, ThumbsUp, Users,
} from "lucide-react";

// v3 P5 → v4 — the compact status strip (docs/redesign-v3.md §5, v4 dedupe).
// ONE line per signal, and each signal lives in EXACTLY ONE row:
// risk · CI · focus · verification · advisory · reviews · scope.
// The old Evidence row (EvidencePanel) duplicated CI + verify + risk — it's
// gone; its unique content split into the Reviews row (reviewer verdicts +
// their attached evidence, via ReviewVerdictsList) and the Scope row.
// Expandable rows REUSE the existing components (ReviewBriefCard,
// VerificationPanel, AdvisoryReviewCard) — demoted from stacked cards to
// collapsed strip rows, not rewritten.
//
// Trust rule: each machine signal carries a provenance badge from a distinct
// tier — "deterministic" (gray — computed, no model), "attested" (primary —
// a server-validated sandboxed run), "advisory" (violet + bot — an LLM
// opinion). Advisory never renders in the same style as attested content.

function ProvenanceBadge({ tier }: { tier: "deterministic" | "attested" | "advisory" }) {
  const style =
    tier === "attested" ? "text-primary border-primary/40"
    : tier === "advisory" ? "text-violet-300 border-violet-400/40"
    : "text-muted-foreground border-border";
  return (
    <span className={`inline-flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider border rounded px-1.5 py-px ${style}`}>
      {tier === "advisory" && <Bot className="h-2.5 w-2.5" />}
      {tier}
    </span>
  );
}

/** One strip row: a single compact line; when `children` are given the row is
 *  expandable and reveals them inline (collapsed by default). */
function StripRow({ icon, label, children, expand }: {
  icon: ReactNode; label: string; children: ReactNode; expand?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const line = (
    <>
      <span className="flex items-center gap-1.5 w-24 shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {icon}{label}
      </span>
      <span className="flex flex-wrap items-center gap-2 min-w-0 flex-1 text-sm">{children}</span>
    </>
  );
  if (!expand) {
    return <div className="flex items-center gap-3 px-3 py-2">{line}</div>;
  }
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent/40">
        {line}
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>
      {open && <div className="px-3 pb-3">{expand}</div>}
    </div>
  );
}

/** How many scope paths the Scope row's expansion shows before "+N more". */
const SCOPE_PATH_CAP = 15;

export function ChangeStatusStrip({
  ns, repo, change, reviews, verification, focus, ciRuns, onJump, onDisableAdvisory,
}: {
  ns: string; repo: string; change: Change; reviews: Review[];
  verification: VerificationRun | null;
  /** The merged source-tagged focus union from the diff endpoint (author + derived + reviewer). */
  focus: ReviewFocus[];
  /** This change's CI runs (page-fetched via api.listCiRuns(ns, repo, changeId));
   *  null while loading. Drives the CI row's exact-run links. */
  ciRuns: CiRun[] | null;
  onJump?: (path: string, line: number) => void;
  onDisableAdvisory?: () => void;
}) {
  const effRisk = effectiveRisk(change);
  const reasons = change.riskReasons ?? [];
  const brief = change.reviewBrief;
  const briefHasContent = (brief?.callouts?.length ?? 0) > 0 || (brief?.derivedFocus?.length ?? 0) > 0;
  const focusFiles = new Set(focus.map(f => f.path)).size;
  const advisory = reviews.filter(r => r.advisory).sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))[0];
  const advisoryVerdict = advisory
    ? advisory.verdict === "approve"
      ? { icon: ThumbsUp, label: "looks good", cls: "text-primary border-primary/40" }
      : advisory.verdict === "request_changes"
        ? { icon: AlertTriangle, label: "concerns", cls: "text-amber-300 border-amber-400/40" }
        : { icon: MessageSquare, label: "comment", cls: "text-sky-300 border-sky-400/40" }
    : null;

  // CI runs for this change, newest first; the status chip links to the newest
  // run at the change's HEAD commit (a stale run from an old push shouldn't be
  // what "ci: success" points at). No run (skipped) → no link.
  const sortedRuns = (ciRuns ?? []).slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const headRun = sortedRuns.find(r => r.commit === change.headCommit) ?? null;
  const runHref = (runId: string) => `/repos/${ns}/${repo}/ci?run=${runId}`;

  // Gating (non-advisory) reviewer verdicts — the Reviews row. Advisory stays
  // in its own row; approval-counting never sees advisory anyway (M4).
  const gatingReviews = reviews.filter(r => !r.advisory);
  const approveCount = gatingReviews.filter(r => r.verdict === "approve").length;
  const changesCount = gatingReviews.filter(r => r.verdict === "request_changes").length;
  const evidenceCount = gatingReviews.reduce((n, r) => n + (r.evidence?.length ?? 0), 0);

  const scopePaths = change.scope ?? [];

  return (
    <div className="rounded-lg border bg-card divide-y divide-border overflow-hidden">
      {/* Risk — computed deterministically from the diff; the trust mechanism,
          one line, always visible. */}
      <StripRow icon={<ShieldAlert className="h-3.5 w-3.5" />} label="Risk">
        <RiskBadge risk={effRisk} />
        {change.computedRisk != null && change.computedRisk !== change.risk && (
          <span className="text-xs text-muted-foreground">computed · declared {change.risk}</span>
        )}
        {reasons.length > 0 && (
          <span className="text-xs text-muted-foreground truncate max-w-[48ch]" title={reasons.join(" · ")}>
            {reasons.slice(0, 2).join(" · ")}{reasons.length > 2 ? ` +${reasons.length - 2} more` : ""}
          </span>
        )}
      </StripRow>

      {/* CI — outcome signal. The chip links to the EXACT newest run at this
          head; the expansion lists every run for this change, each linked. */}
      <StripRow icon={<FlaskConical className="h-3.5 w-3.5" />} label="CI"
        expand={sortedRuns.length > 0 ? (
          <ul className="space-y-1.5">
            {sortedRuns.map(run => (
              <li key={run.id}>
                <Link href={runHref(run.id)}
                  className="flex items-center gap-2 rounded border border-border/60 bg-muted/30 px-2.5 py-1.5 hover:bg-accent/40 transition-colors">
                  <CiStatusPill status={run.status} />
                  {run.commit && (
                    <code className={`font-mono text-[10px] ${run.commit === change.headCommit ? "text-foreground" : "text-muted-foreground"}`}>
                      {run.commit.slice(0, 7)}{run.commit === change.headCommit ? " (head)" : ""}
                    </code>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground shrink-0">{relativeTime(new Date(run.createdAt))} →</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : undefined}>
        {change.ciStatus === "skipped" && !headRun
          ? <span className="text-xs text-muted-foreground">no pipelines configured</span>
          : headRun
            ? <Link href={runHref(headRun.id)} title="Open this run" className="hover:opacity-80"><CiStatusPill status={change.ciStatus} /></Link>
            : <CiStatusPill status={change.ciStatus} />}
      </StripRow>

      {/* Focus — the deterministic focus floor. Expands to the full Review
          Brief (critical decisions) when the server derived one. */}
      {(focus.length > 0 || briefHasContent) && (
        <StripRow icon={<Flag className="h-3.5 w-3.5" />} label="Focus"
          expand={briefHasContent ? <ReviewBriefCard brief={brief} onJump={onJump} /> : undefined}>
          <span>
            {focus.length} flagged region{focus.length === 1 ? "" : "s"} across {focusFiles} file{focusFiles === 1 ? "" : "s"}
          </span>
          <ProvenanceBadge tier="deterministic" />
        </StripRow>
      )}

      {/* Verification — a server-validated sandboxed-run attestation, pinned to
          this head. A stronger trust tier than any LLM opinion. */}
      <StripRow icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Verify"
        expand={verification ? <VerificationPanel verification={verification} /> : undefined}>
        {verification ? (() => {
          // A success attestation the merge gate no longer honors (verifying agent
          // disabled or self-verify) must NOT render green "passed" + attested —
          // that would claim a signal the gate already dropped (#78).
          const stale = verification.status === "success" && verification.counts === false;
          return (
            <>
              <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                stale
                  ? "text-amber-300 border-amber-400/40 bg-amber-500/10"
                  : verification.status === "success"
                    ? "text-primary border-primary/40 bg-primary/10"
                    : verification.status === "failure"
                      ? "text-destructive border-destructive/40 bg-destructive/10"
                      : "text-muted-foreground border-border bg-muted/30"
              }`}>
                {stale ? "not counted" : verification.status === "success" ? "passed" : verification.status === "failure" ? "failed" : "pending"}
              </span>
              <span className="text-xs text-muted-foreground">
                {verification.passedCount}/{verification.passedCount + verification.failedCount} checks
              </span>
              {stale
                ? <span className="text-[10px] font-medium uppercase tracking-wider text-amber-300" title="The verifying agent was disabled, so the merge gate no longer honors this attestation.">verifier disabled</span>
                : <ProvenanceBadge tier="attested" />}
            </>
          );
        })() : (
          <span className="text-xs text-muted-foreground">none</span>
        )}
      </StripRow>

      {/* Advisory — the native reviewer's LLM opinion. Informs, never gates;
          always labeled, never styled like attested content. */}
      {advisory && advisoryVerdict && (
        <StripRow icon={<Bot className="h-3.5 w-3.5" />} label="Advisory"
          expand={<AdvisoryReviewCard reviews={reviews} onJump={onJump} onDisable={onDisableAdvisory} />}>
          <span className={`inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider border rounded px-1.5 py-0.5 ${advisoryVerdict.cls}`}>
            <advisoryVerdict.icon className="h-3 w-3" /> {advisoryVerdict.label}
          </span>
          {advisory.contract?.model && (
            <span className="text-[10px] font-medium uppercase tracking-wider text-sky-300 border border-sky-400/40 rounded px-1.5 py-0.5">
              {advisory.contract.model}
            </span>
          )}
          <ProvenanceBadge tier="advisory" />
        </StripRow>
      )}

      {/* Reviews — reviewer verdicts with basis chips + their attached evidence
          (screenshots, transcripts, the visual triptych). The unique half of the
          old Evidence row. */}
      <StripRow icon={<Users className="h-3.5 w-3.5" />} label="Reviews"
        expand={gatingReviews.length > 0 ? <ReviewVerdictsList change={change} reviews={reviews} /> : undefined}>
        {gatingReviews.length === 0 ? (
          <span className="text-xs text-muted-foreground">none yet</span>
        ) : (
          <>
            <span>{gatingReviews.length} review{gatingReviews.length === 1 ? "" : "s"}</span>
            {approveCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider border rounded px-1.5 py-0.5 text-primary border-primary/40">
                <ThumbsUp className="h-3 w-3" /> {approveCount} approve
              </span>
            )}
            {changesCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider border rounded px-1.5 py-0.5 text-amber-300 border-amber-400/40">
                <AlertTriangle className="h-3 w-3" /> {changesCount} request changes
              </span>
            )}
            {evidenceCount > 0 && (
              <span className="text-xs text-muted-foreground">{evidenceCount} evidence item{evidenceCount === 1 ? "" : "s"}</span>
            )}
          </>
        )}
      </StripRow>

      {/* Scope — the paths this change declares/touches, as compact chips. */}
      {scopePaths.length > 0 && (
        <StripRow icon={<Target className="h-3.5 w-3.5" />} label="Scope"
          expand={
            <div className="flex flex-wrap gap-1">
              {scopePaths.slice(0, SCOPE_PATH_CAP).map(s => (
                <code key={s} className="text-xs px-1.5 py-0.5 rounded bg-muted">{s}</code>
              ))}
              {scopePaths.length > SCOPE_PATH_CAP && (
                <span className="text-xs text-muted-foreground self-center">+{scopePaths.length - SCOPE_PATH_CAP} more</span>
              )}
            </div>
          }>
          <span className="text-xs text-muted-foreground truncate max-w-[48ch]" title={scopePaths.join(" · ")}>
            {scopePaths.length} path{scopePaths.length === 1 ? "" : "s"} · {scopePaths.slice(0, 3).join(" · ")}{scopePaths.length > 3 ? " …" : ""}
          </span>
        </StripRow>
      )}
    </div>
  );
}
