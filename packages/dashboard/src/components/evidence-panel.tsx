"use client";

import { useEffect, useState } from "react";
import { type Change, type Review, type ReviewEvidence } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { ReviewBasisChip } from "@/components/review-basis-chip";

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

/**
 * Reviewer verdicts with basis chips + their attached evidence (screenshots,
 * transcripts, the visual triptych). Extracted from the old EvidencePanel —
 * the strip's Reviews row is its home now (v4: the strip dedupe removed the
 * Evidence row, and CI/risk/scope each live in exactly one row).
 * Advisory (native-reviewer) verdicts are surfaced by AdvisoryReviewCard, NOT
 * here — filtered so a machine "approve" doesn't add a green APPROVE badge or
 * inflate the gating-review count (M4).
 */
export function ReviewVerdictsList({ change, reviews }: { change: Change; reviews: Review[] }) {
  const gatingReviews = reviews.filter(r => !r.advisory);
  // A change is authored by EITHER an agent (acting under a human owner) OR a
  // human directly (openedByUserName, who IS the owner). Read defensively:
  // fields may be briefly absent.
  const humanAuthor = (change as Change & { openedByUserName?: string | null }).openedByUserName ?? null;
  // Owner only applies to agent-authored changes (the human the agent acts for).
  const owner = humanAuthor ? null : (change as Change & { owner?: string | null }).owner ?? null;

  if (gatingReviews.length === 0) {
    return <p className="text-xs text-muted-foreground">No reviews yet.</p>;
  }
  return (
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
  );
}
