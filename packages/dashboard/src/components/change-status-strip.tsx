"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { effectiveRisk, type Change, type MergeDecision, type Review, type ReviewFocus, type VerificationRun } from "@/lib/api";
import { RiskBadge } from "@/components/risk-badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { ReviewBriefCard } from "@/components/review-brief";
import { AdvisoryReviewCard } from "@/components/advisory-review-card";
import { VerificationPanel } from "@/components/verification-panel";
import { EvidencePanel } from "@/components/evidence-panel";
import {
  AlertTriangle, Bot, ChevronDown, ChevronRight, Flag, FlaskConical,
  MessageSquare, Paperclip, ShieldAlert, ShieldCheck, ThumbsUp,
} from "lucide-react";

// v3 P5 — the compact status strip (docs/redesign-v3.md §5). Replaces the
// stacked-card pile (brief card + advisory card + verification panel) with ONE
// line per signal: risk · CI · focus · verification · advisory · evidence.
// Expandable rows REUSE the existing components (ReviewBriefCard,
// VerificationPanel, AdvisoryReviewCard, EvidencePanel) — they're demoted from
// always-visible cards to collapsed strip rows, not rewritten.
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

export function ChangeStatusStrip({
  ns, repo, change, mergeable, reviews, verification, focus, solo, onJump, onDisableAdvisory,
}: {
  ns: string; repo: string; change: Change; mergeable: MergeDecision; reviews: Review[];
  verification: VerificationRun | null;
  /** The merged source-tagged focus union from the diff endpoint (author + derived + reviewer). */
  focus: ReviewFocus[];
  solo: boolean;
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

      {/* CI — outcome signal + a jump to the runs surface. */}
      <StripRow icon={<FlaskConical className="h-3.5 w-3.5" />} label="CI">
        {change.ciStatus === "skipped"
          ? <span className="text-xs text-muted-foreground">no pipelines configured</span>
          : <CiStatusPill status={change.ciStatus} />}
        <Link href={`/repos/${ns}/${repo}/ci`} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          view runs
        </Link>
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
        {verification ? (
          <>
            <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
              verification.status === "success"
                ? "text-primary border-primary/40 bg-primary/10"
                : verification.status === "failure"
                  ? "text-destructive border-destructive/40 bg-destructive/10"
                  : "text-muted-foreground border-border bg-muted/30"
            }`}>
              {verification.status === "success" ? "passed" : verification.status === "failure" ? "failed" : "pending"}
            </span>
            <span className="text-xs text-muted-foreground">
              {verification.passedCount}/{verification.passedCount + verification.failedCount} checks
            </span>
            <ProvenanceBadge tier="attested" />
          </>
        ) : (
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

      {/* Everything EvidencePanel uniquely renders (CI runs with per-step
          results + artifacts, reviewer verdicts with their evidence/triptych,
          scope, merge readiness) — kept, demoted to one collapsed row. */}
      <StripRow icon={<Paperclip className="h-3.5 w-3.5" />} label="Evidence"
        expand={<EvidencePanel ns={ns} repo={repo} change={change} mergeable={mergeable} reviews={reviews} solo={solo} />}>
        <span className="text-xs text-muted-foreground">CI runs, artifacts &amp; reviewer evidence</span>
      </StripRow>
    </div>
  );
}
