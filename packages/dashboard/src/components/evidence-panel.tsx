"use client";

import { useEffect, useState } from "react";
import {
  api, effectiveRisk,
  type Change, type CiArtifact, type CiRun, type MergeDecision, type Review, type ReviewEvidence,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { ReviewBasisChip } from "@/components/review-basis-chip";
import { RISK_COLOR } from "@/components/risk-badge";
import { displayBranch } from "@/lib/branch";
import { shortMergeBlock } from "@/lib/merge-reason";
import { Target, ShieldAlert, FlaskConical, Users, Paperclip, GitCommitHorizontal } from "lucide-react";

/** Per-step CI result entry (the runner reports these; the reaper writes a
 *  single { name: "reaper", note } when no runner ever claimed the run). Shape
 *  lives on the ci_runs jsonb column, not the typed CiRun, so we narrow locally. */
type StepResult = { name: string; status?: string; note?: string };

/**
 * Render an image that lives behind ClawHub's auth (a Change's evidence blob is
 * served through a read-authorized GET, so a private repo's screenshots stay
 * private). A plain <img src> can't send the Bearer token, so we fetch the bytes
 * with auth and hand the browser an object URL. External screenshot URLs (an
 * arbitrary `url` an agent supplied) fall back to a plain <img>.
 */
function AuthedImg({ url, alt, full = false }: { url: string; alt: string; full?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const apiHosted = url.includes("/api/v1/repos/") && url.includes("/evidence/");
  useEffect(() => {
    if (!apiHosted) { setSrc(url); return; }
    let live = true; let obj: string | null = null;
    const token = typeof window !== "undefined" ? localStorage.getItem("clawhub_token") : null;
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(b => { if (!live) return; obj = URL.createObjectURL(b); setSrc(obj); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (obj) URL.revokeObjectURL(obj); };
  }, [url, apiHosted]);
  if (failed) return <a href={url} target="_blank" rel="noreferrer" className="text-xs text-primary underline break-all">{url}</a>;
  if (!src) return <div className="h-24 animate-pulse rounded border border-border bg-muted/30" />;
  // For api-hosted blobs the object URL isn't externally linkable, so only wrap
  // external URLs in an anchor.
  // `full` → fill the parent column (the triptych grid) instead of natural size.
  const img = <img src={src} alt={alt} className={`rounded border border-border max-h-64${full ? " w-full object-contain" : ""}`} />;
  return apiHosted ? img : <a href={url} target="_blank" rel="noreferrer">{img}</a>;
}

/**
 * N4 visual triptych (non-gating design evidence): evidence items whose label
 * starts with "visual:base" / "visual:head" / "visual:diff" (case-insensitive)
 * form one group per review — rendered as a side-by-side Base / Head / Diff row
 * when ≥2 members are present (a missing member shows a muted empty slot). The
 * harness attaches these labels from `attach_visual_triptych` in
 * packages/agent-harness/entrypoint.sh. Anything else renders as before.
 */
const TRIPTYCH_SLOTS = ["base", "head", "diff"] as const;
type TriptychSlot = (typeof TRIPTYCH_SLOTS)[number];
function triptychSlot(e: ReviewEvidence): TriptychSlot | null {
  const label = (e.label ?? "").toLowerCase();
  for (const slot of TRIPTYCH_SLOTS) if (label.startsWith(`visual:${slot}`)) return slot;
  return null;
}

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
  ns, repo, change, mergeable, reviews, solo = true,
}: {
  ns: string; repo: string; change: Change; mergeable: MergeDecision; reviews: Review[];
  /** true → solo USER-namespace repo, viewer is the author; false → org/team
   *  context where self-approval is NOT the expected path. */
  solo?: boolean;
}) {
  // Advisory (native-reviewer) verdicts are surfaced by AdvisoryReviewCard, NOT in
  // the human Reviews list — filter them here so a machine "approve" doesn't add a
  // green APPROVE badge + inflate the gating-review count (M4).
  const gatingReviews = reviews.filter(r => !(r as Review & { advisory?: boolean }).advisory);
  // New fields the API resolves for separation-of-duties legibility. Read them
  // defensively so the panel compiles + renders even if a field is briefly
  // absent (the resolving change shipped from another route).
  //
  // A change is authored by EITHER an agent (openedByAgentName, acting under a
  // human owner) OR a human directly (openedByUserName, who IS the owner — no
  // separate owner suffix). Humans and agents both commit; the human-author case
  // simply has no acting-for relationship to spell out.
  const agentAuthor = (change as Change & { openedByAgentName?: string | null }).openedByAgentName ?? null;
  const humanAuthor = (change as Change & { openedByUserName?: string | null }).openedByUserName ?? null;
  // Owner only applies to agent-authored changes (the human the agent acts for).
  const owner = humanAuthor ? null : (change as Change & { owner?: string | null }).owner ?? null;
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
          <span className="font-mono" title={change.branch}>{displayBranch(change.branch)}</span>
          {/* Authorship — who wrote this change, made legible for
              separation-of-duties. A human author wrote it themselves (no owner
              to spell out); an agent author acts under a human owner. An approver
              who is that owner (or the human author) is NOT independent. */}
          {(humanAuthor || agentAuthor || owner) && (
            <span className="inline-flex items-center gap-1">
              <span className="text-muted-foreground/50">·</span>
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              authored by
              {humanAuthor ? (
                <span className="font-mono text-foreground">@{humanAuthor}</span>
              ) : (
                <>
                  {agentAuthor && <span className="font-mono text-foreground">@{agentAuthor}</span>}
                  {owner && (
                    <span className="text-muted-foreground">
                      for <span className="font-mono text-foreground">@{owner}</span>
                    </span>
                  )}
                </>
              )}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Effective risk + explainability — the trust mechanism, shown not hidden. */}
        <Section icon={<ShieldAlert className="h-3.5 w-3.5" />} title="Risk">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${RISK_COLOR[effRisk]}`}>
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
              {runs.map(run => {
                // stepResults is on the API row (jsonb) but not the typed CiRun —
                // read it defensively. Each entry is { name, status?, note? }; the
                // reaper writes a single { name: "reaper", note: "no terminal
                // report from any runner…" } when no runner ever claimed the run,
                // which is the common solo-dev "no runner" case.
                const steps = (run as { stepResults?: StepResult[] }).stepResults ?? [];
                const showSteps = run.status === "failure" && steps.length > 0;
                return (
                <li key={run.id} className="rounded border border-border bg-muted/30 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <CiStatusPill status={run.status} />
                    {run.logUrl && (
                      <a href={run.logUrl} target="_blank" rel="noreferrer" className="text-[11px] font-mono underline text-muted-foreground hover:text-foreground">logs</a>
                    )}
                  </div>
                  {/* Per-step results on failure — turns a bare "CI failed" into
                      something self-explanatory (esp. the reaper "no runner" note). */}
                  {showSteps && (
                    <ul className="mt-1.5 space-y-1">
                      {steps.map((s, i) => (
                        <li key={i} className="text-[11px] text-muted-foreground">
                          <span className="font-mono">{s.name}</span>
                          {s.status && <span className="ml-1 uppercase">· {s.status}</span>}
                          {s.note && <span className="block text-muted-foreground/80">{s.note}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
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
                );
              })}
            </ul>
          )}
        </Section>

        {/* Reviewer verdicts, each tagged with what it rests on. */}
        <Section icon={<Users className="h-3.5 w-3.5" />} title={`Reviews (${gatingReviews.length})`}>
          {gatingReviews.length === 0 ? (
            <p className="text-xs text-muted-foreground">No reviews yet.</p>
          ) : (
            <ul className="space-y-2">
              {gatingReviews.map(r => {
                // Prefer the resolved reviewer name (e.g. "@security-reviewer");
                // fall back to the bare kind ("agent"/"human") if absent.
                const reviewerName = (r as Review & { reviewerName?: string | null }).reviewerName ?? null;
                // Separation-of-duties legibility on approvals: tag whether the
                // approver is the change's OWN owner/author (not independent) or a
                // DIFFERENT human (independent). The "self" name is the human
                // author when present (they wrote it), else the agent's owner.
                // Only assert either when both the self + reviewer names resolve —
                // never guess from a bare kind.
                const norm = (s: string) => s.replace(/^@/, "").toLowerCase();
                const selfName = humanAuthor ?? owner;
                const selfResolved = r.verdict === "approve" && !!selfName && !!reviewerName;
                const isOwnerApproval = selfResolved && norm(reviewerName!) === norm(selfName!);
                const isIndependentHuman =
                  selfResolved && r.reviewerKind === "human" && norm(reviewerName!) !== norm(selfName!);
                // Visual triptych grouping (see triptychSlot above): first URL-bearing
                // member per slot joins the group; with ≥2 members the group renders as
                // one Base/Head/Diff row and everything else renders exactly as before.
                const evAll = r.evidence ?? [];
                const slots: Partial<Record<TriptychSlot, ReviewEvidence>> = {};
                for (const e of evAll) {
                  const slot = e.url ? triptychSlot(e) : null;
                  if (slot && !slots[slot]) slots[slot] = e;
                }
                const grouped = Object.values(slots).length >= 2;
                const groupIds = new Set(grouped ? Object.values(slots).map(e => e.id) : []);
                const restEv = evAll.filter(e => !groupIds.has(e.id));
                return (
                <li key={r.id} className="border-l-2 border-border pl-3 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant={r.verdict === "approve" ? "default" : r.verdict === "request_changes" ? "destructive" : "secondary"}
                      className="text-[10px] uppercase"
                    >
                      {r.verdict.replace("_", " ")}
                    </Badge>
                    <ReviewBasisChip basis={r.basis ?? "code"} />
                    {/* WHO reviewed — name when resolved, else the bare kind. */}
                    {reviewerName ? (
                      <code className="text-[11px] font-mono text-foreground">@{reviewerName.replace(/^@/, "")}</code>
                    ) : (
                      <code className="text-[11px] font-mono text-muted-foreground">{r.reviewerKind}</code>
                    )}
                    {isOwnerApproval ? (
                      <span className="text-[10px] text-muted-foreground">· own owner</span>
                    ) : isIndependentHuman ? (
                      <span className="text-[10px] text-primary">· independent reviewer</span>
                    ) : null}
                  </div>
                  {r.summary && <p className="mt-1 text-xs text-muted-foreground">{r.summary}</p>}
                  {(grouped || restEv.length > 0) && (
                    <div className="mt-2 space-y-1.5">
                      {/* Base / Head / Diff triptych — one full-width grouped row. */}
                      {grouped && (
                        <div className="rounded border border-border/60 bg-muted/30 p-2">
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">visual diff</div>
                          <div className="grid grid-cols-3 gap-1.5">
                            {TRIPTYCH_SLOTS.map(slot => {
                              const e = slots[slot];
                              return (
                                <div key={slot} className="min-w-0">
                                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{slot}</div>
                                  {e?.url ? (
                                    <AuthedImg url={e.url} alt={e.label || `visual ${slot}`} full />
                                  ) : (
                                    <div className="flex h-24 items-center justify-center rounded border border-dashed border-border/60 text-[10px] text-muted-foreground/60">
                                      no {slot}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {restEv.map(e => (
                        <div key={e.id} className="rounded border border-border/60 bg-muted/30 p-2">
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{e.label || e.kind.replace("_", " ")}</div>
                          {e.content && <pre className="text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-auto">{e.content}</pre>}
                          {e.url && e.kind === "screenshot" && <AuthedImg url={e.url} alt={e.label || "screenshot"} />}
                          {e.url && e.kind !== "screenshot" && <a href={e.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline break-all">{e.url}</a>}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
                );
              })}
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

        {/* Merge readiness — just the STATE here. The full "what unblocks it"
            guidance (incl. Solo mode) lives in the Review & merge action panel, so
            we don't repeat the same paragraph in two columns. */}
        <div className="pt-1 border-t border-border">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1 mt-3">Merge</div>
          {mergeable.mergeable ? (
            <div className="text-sm text-primary">Ready to merge</div>
          ) : mergeable.reason === "needs_code_review" ? (
            <div className="text-sm text-orange-400">
              Needs a code-level review
              <span className="block text-xs text-muted-foreground font-normal mt-0.5">High risk or a sensitive path.</span>
            </div>
          ) : (
            <div className="text-sm">
              <span className="text-yellow-400">Blocked</span>
              <span className="block text-xs text-muted-foreground mt-0.5">{shortMergeBlock(mergeable.reason)} — see Review &amp; merge to unblock.</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
