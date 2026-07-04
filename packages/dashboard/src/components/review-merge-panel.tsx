"use client";

import { useState } from "react";
import { api, type MergeDecision, type MergeMethod, type RepoAccess, type ReviewBasis, type ReviewEvidenceInput, type Verdict } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { humanizeMergeReason } from "@/lib/merge-reason";
import { Check, ChevronDown, GitMerge, Info } from "lucide-react";

const METHOD_LABEL: Record<MergeMethod, string> = { merge: "Merge commit", squash: "Squash & merge", rebase: "Rebase & merge" };
const BASES: Array<{ value: ReviewBasis; label: string }> = [
  { value: "behavior", label: "Verified the behavior" },
  { value: "code", label: "Reviewed the code" },
  { value: "both", label: "Both" },
];
const VERDICTS: Array<{ value: Verdict; label: string }> = [
  { value: "approve", label: "Approve" },
  { value: "request_changes", label: "Request changes" },
  { value: "comment", label: "Comment" },
];
// Block reasons that an APPROVING review would clear — so we can offer
// "Approve & merge" in one click instead of approve-then-scroll-up-to-merge.
const APPROVAL_UNBLOCKS = new Set(["needs_human_approval", "needs_more_approvals", "needs_code_review", "needs_independent_approver"]);

/**
 * One panel for the whole review→merge handoff, replacing the old split between
 * a separate "Actions" merge control and a "Submit a review" card. It reads the
 * merge gate and the caller's access level to offer the single most useful
 * action:
 *   - the change is already mergeable + you can merge → a prominent **Merge**;
 *   - you're approving and your approval is what unblocks it → **Approve & merge**
 *     (one click), with **Approve only** in the ▾ for "accept, let the author ship";
 *   - otherwise just **Approve** / **Request changes** / **Comment**.
 * A reviewer with only the `review` grant sees the verdict actions but never a
 * merge button (merge needs write).
 */
export function ReviewMergePanel({
  ns, repo, changeId, isDraft, hasConflicts, behindBase = false, mergeable, viewerAccess, methods,
  needsCodeReview, solo, settingsHref, confirmBeforeSubmit, onDone,
}: {
  ns: string; repo: string; changeId: string;
  isDraft: boolean; hasConflicts: boolean; behindBase?: boolean;
  mergeable: MergeDecision; viewerAccess: RepoAccess; methods: MergeMethod[];
  needsCodeReview: boolean; solo: boolean; settingsHref?: string;
  confirmBeforeSubmit?: (verdict: Verdict) => boolean;
  onDone: () => void;
}) {
  const [verdict, setVerdict] = useState<Verdict>("approve");
  const [basis, setBasis] = useState<ReviewBasis>(needsCodeReview ? "code" : "behavior");
  const [summary, setSummary] = useState("");
  const [evidenceOutput, setEvidenceOutput] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [method, setMethod] = useState<MergeMethod>(methods[0] ?? "merge");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [updateMenuOpen, setUpdateMenuOpen] = useState(false);

  const canReview = viewerAccess === "review" || viewerAccess === "write" || viewerAccess === "admin";
  const canWrite = viewerAccess === "write" || viewerAccess === "admin";
  const canMerge = canWrite && !hasConflicts && !isDraft;
  const mergeableNow = mergeable.mergeable;
  const blockReason = !mergeableNow ? mergeable.reason : undefined;
  const approveUnblocks = !mergeableNow && APPROVAL_UNBLOCKS.has(blockReason ?? "");
  // "Approve & merge" only when approving is what clears the gate AND you can
  // merge. If it's already mergeable, the standalone Merge above handles it; if
  // the block is CI/conflicts, approving won't help.
  const offerApproveAndMerge = canMerge && verdict === "approve" && approveUnblocks;

  function buildEvidence(): ReviewEvidenceInput[] | undefined {
    const ev: ReviewEvidenceInput[] = [];
    if (evidenceOutput.trim()) ev.push({ kind: "test_output", label: "Test / CLI output", content: evidenceOutput.trim() });
    if (evidenceUrl.trim()) ev.push({ kind: /\.(png|jpe?g|gif|webp)(\?|$)/i.test(evidenceUrl.trim()) ? "screenshot" : "link", label: "Attachment", url: evidenceUrl.trim() });
    return ev.length ? ev : undefined;
  }

  async function submitReview(v: Verdict, alsoMerge: boolean) {
    if (confirmBeforeSubmit && !confirmBeforeSubmit(v)) return;
    setPending(true); setError(null); setNote(null); setMenuOpen(false);
    try {
      const res = await api.submitReview(ns, repo, changeId, { verdict: v, basis, summary: summary || undefined, evidence: buildEvidence() });
      if (res.idempotent) {
        // Already held this exact stance — the server changed nothing. Keep the
        // form as-is so the user can tweak it into a real change, and say so.
        setNote("You already recorded this exact review — change the verdict, basis, or summary to submit a new one.");
      } else {
        setSummary(""); setEvidenceOutput(""); setEvidenceUrl("");
      }
      if (alsoMerge && v === "approve") {
        // The approval is recorded; try to merge now. If the gate still blocks
        // (e.g. CI just went pending, an independent approver is needed), say WHY
        // rather than failing — the review still landed.
        try { await api.mergeChange(ns, repo, changeId, method); }
        catch (e) { setNote(`Approved — but not merged: ${(e as Error).message}`); }
      }
      onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  async function mergeOnly() {
    setPending(true); setError(null); setNote(null);
    try { await api.mergeChange(ns, repo, changeId, method); onDone(); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  // Bring the change current with the base branch. A content conflict comes back
  // as an error telling the user to rebase locally; success reloads the change.
  async function updateBranch(m: "merge" | "rebase") {
    setPending(true); setError(null); setNote(null); setUpdateMenuOpen(false);
    try { await api.updateChangeBranch(ns, repo, changeId, m); onDone(); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  // The smart primary review button: label + action follow the selected verdict
  // and the gate. `alt` (when set) is the secondary action behind the ▾.
  let primaryLabel: string;
  let primaryAction: () => void;
  let alt: { label: string; action: () => void } | null = null;
  let destructive = false;
  if (verdict === "approve") {
    if (offerApproveAndMerge) {
      primaryLabel = "Approve & merge"; primaryAction = () => submitReview("approve", true);
      alt = { label: "Approve only (let the author merge)", action: () => submitReview("approve", false) };
    } else {
      primaryLabel = "Approve"; primaryAction = () => submitReview("approve", false);
    }
  } else if (verdict === "request_changes") {
    primaryLabel = "Request changes"; primaryAction = () => submitReview("request_changes", false); destructive = true;
  } else {
    primaryLabel = "Comment"; primaryAction = () => submitReview("comment", false);
  }

  const methodSelect = methods.length > 1 ? (
    <Select value={method} onValueChange={v => setMethod((v as MergeMethod) ?? methods[0] ?? "merge")}>
      <SelectTrigger className="h-9 w-auto text-xs" aria-label="Merge method"><SelectValue /></SelectTrigger>
      <SelectContent>{methods.map(m => <SelectItem key={m} value={m}>{METHOD_LABEL[m]}</SelectItem>)}</SelectContent>
    </Select>
  ) : null;

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Review &amp; merge</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {/* Merge state first: ready-to-ship gets a prominent Merge; a blocked
            change gets the one-line reason right where you'd act on it. */}
        {mergeableNow ? (
          <div className="rounded border border-primary/30 bg-primary/5 p-3 space-y-2">
            <p className="text-sm font-medium text-primary flex items-center gap-1.5"><Check className="h-4 w-4" /> Ready to merge</p>
            {canMerge ? (
              <div className="flex gap-2">
                {methodSelect}
                <Button onClick={mergeOnly} disabled={pending} className="flex-1 gap-1.5">
                  <GitMerge className="h-4 w-4" /> {pending ? "Merging…" : "Merge"}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">A maintainer with write access can merge it.</p>
            )}
          </div>
        ) : blockReason ? (
          <Alert>
            <AlertDescription className="text-sm">
              {humanizeMergeReason(blockReason, { solo })}
              {solo && approveUnblocks && settingsHref && (
                <>
                  {" "}
                  <a href={settingsHref} className="font-medium underline underline-offset-2">Enable Solo mode</a>{" "}
                  to let your agent self-approve low-risk work (sensitive paths + high risk still need a human).
                </>
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        {(behindBase || hasConflicts) && (
          <div className="rounded border border-border bg-muted/30 p-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              {hasConflicts
                ? "This change conflicts with the base branch."
                : "This change is behind the base branch — bring it up to date to re-test against the latest base."}
            </p>
            {canWrite ? (
              <div className="space-y-2">
                <div className="inline-flex">
                  <Button variant="secondary" disabled={pending} onClick={() => updateBranch("merge")} className="rounded-r-none gap-1.5">
                    <GitMerge className="h-4 w-4" /> {pending ? "Updating…" : "Update branch"}
                  </Button>
                  <Button variant="secondary" disabled={pending} aria-label="Update method" aria-expanded={updateMenuOpen}
                    className="rounded-l-none border-l border-border px-2" onClick={() => setUpdateMenuOpen(o => !o)}>
                    <ChevronDown className={`h-4 w-4 transition-transform ${updateMenuOpen ? "rotate-180" : ""}`} />
                  </Button>
                </div>
                {updateMenuOpen && (
                  <button type="button" onClick={() => updateBranch("rebase")} disabled={pending}
                    className="block w-full text-left text-sm px-3 py-2 rounded border border-border hover:bg-muted">
                    Rebase onto the base branch
                  </button>
                )}
                {hasConflicts && <p className="text-[11px] text-muted-foreground">If it can&apos;t auto-resolve, you&apos;ll be asked to rebase locally.</p>}
              </div>
            ) : (
              <p className="text-xs text-destructive">Rebase on the base branch and push again.</p>
            )}
          </div>
        )}

        {/* Review form — a reviewer-grant caller can leave a verdict but not merge. */}
        {canReview && (
          <div className="space-y-3 pt-1 border-t border-border/60">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Leave a review</div>

            {needsCodeReview && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  This change needs a code-level review (high risk or sensitive paths). A behavior-only approval won&apos;t unblock the merge.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              {VERDICTS.map(v => (
                <button key={v.value} type="button" onClick={() => setVerdict(v.value)}
                  className={`px-3 py-1.5 text-xs font-mono rounded border ${verdict === v.value ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"}`}>
                  {v.label}
                </button>
              ))}
            </div>

            <fieldset>
              <legend className="text-xs font-medium uppercase tracking-wider text-muted-foreground">What did you verify?</legend>
              <div className="mt-2 space-y-1.5">
                {BASES.map(b => {
                  const deemphasized = needsCodeReview && verdict === "approve" && b.value === "behavior";
                  const selected = basis === b.value;
                  return (
                    <label key={b.value}
                      className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-1 -mx-1.5 ${selected ? "text-foreground" : "text-muted-foreground hover:text-foreground"} ${deemphasized ? "opacity-50" : ""}`}>
                      <input type="radio" name="basis" value={b.value} checked={selected} onChange={() => setBasis(b.value)} className="accent-primary" />
                      <span>{b.label}</span>
                      {deemphasized && <span className="text-[10px] text-muted-foreground">(won&apos;t satisfy the gate)</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div>
              <Label htmlFor="review-summary" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Summary</Label>
              <Textarea id="review-summary" value={summary} onChange={e => setSummary(e.target.value)} rows={3} placeholder="Optional — what did you check?" />
            </div>

            <details className="rounded border border-border/60 px-2 py-1.5">
              <summary className="text-xs font-medium uppercase tracking-wider text-muted-foreground cursor-pointer">Attach evidence (optional)</summary>
              <div className="mt-2 space-y-2">
                <Textarea value={evidenceOutput} onChange={e => setEvidenceOutput(e.target.value)} rows={4}
                  placeholder="Paste test or CLI output you ran to verify this — the proof, not just a claim." className="font-mono text-xs" />
                <input type="url" value={evidenceUrl} onChange={e => setEvidenceUrl(e.target.value)}
                  placeholder="Screenshot or log URL (optional)" className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
              </div>
            </details>

            {/* Smart split button: primary = the most useful action for the
                selected verdict + gate; the ▾ reveals the alternative (e.g.
                approve WITHOUT merging) inline — rendered in normal flow, not an
                absolute popover, because the Card clips overflow. */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="inline-flex">
                  <Button variant={destructive ? "destructive" : "default"} disabled={pending} onClick={primaryAction}
                    className={alt ? "rounded-r-none" : ""}>
                    {pending ? "Working…" : primaryLabel}
                  </Button>
                  {alt && (
                    <Button variant={destructive ? "destructive" : "default"} disabled={pending} aria-label="More actions"
                      aria-expanded={menuOpen} className="rounded-l-none border-l border-background/30 px-2" onClick={() => setMenuOpen(o => !o)}>
                      <ChevronDown className={`h-4 w-4 transition-transform ${menuOpen ? "rotate-180" : ""}`} />
                    </Button>
                  )}
                </div>
                {offerApproveAndMerge && methodSelect}
              </div>
              {alt && menuOpen && (
                <button type="button" onClick={alt.action} disabled={pending}
                  className="block w-full text-left text-sm px-3 py-2 rounded border border-border hover:bg-muted">
                  {alt.label}
                </button>
              )}
            </div>

            {note && <p className="text-xs text-amber-500">{note}</p>}
          </div>
        )}

        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      </CardContent>
    </Card>
  );
}
