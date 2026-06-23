"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api, type ReviewBasis, type ReviewEvidenceInput, type Verdict } from "@/lib/api";
import { Info } from "lucide-react";

const BASES: Array<{ value: ReviewBasis; label: string }> = [
  { value: "behavior", label: "Verified the behavior" },
  { value: "code", label: "Reviewed the code" },
  { value: "both", label: "Both" },
];

export function ReviewForm({
  ns, repo, changeId, needsCodeReview = false, onSubmitted, confirmBeforeSubmit,
}: {
  ns: string; repo: string; changeId: string; needsCodeReview?: boolean; onSubmitted: () => void;
  // Optional gate run with the real selected verdict before the form submits.
  // Return false to cancel the submit (e.g. a confirm() the user declined).
  confirmBeforeSubmit?: (verdict: Verdict) => boolean;
}) {
  const [verdict, setVerdict] = useState<Verdict>("approve");
  // Default to the basis that satisfies the gate when code review is required.
  const [basis, setBasis] = useState<ReviewBasis>(needsCodeReview ? "code" : "behavior");
  const [summary, setSummary] = useState("");
  // Evidence: the proof you actually verified it (#6) — pasted test/CLI output
  // and/or a screenshot/log URL.
  const [evidenceOutput, setEvidenceOutput] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Run the parent's guard against the REAL verdict (not DOM text) — if it
    // declines, cancel the submit before any network call.
    if (confirmBeforeSubmit && !confirmBeforeSubmit(verdict)) return;
    setPending(true); setError(null);
    try {
      const evidence: ReviewEvidenceInput[] = [];
      if (evidenceOutput.trim()) evidence.push({ kind: "test_output", label: "Test / CLI output", content: evidenceOutput.trim() });
      if (evidenceUrl.trim()) evidence.push({ kind: /\.(png|jpe?g|gif|webp)(\?|$)/i.test(evidenceUrl.trim()) ? "screenshot" : "link", label: "Attachment", url: evidenceUrl.trim() });
      await api.submitReview(ns, repo, changeId, { verdict, basis, summary: summary || undefined, evidence: evidence.length ? evidence : undefined });
      setSummary(""); setEvidenceOutput(""); setEvidenceUrl("");
      onSubmitted();
    } catch (err) { setError((err as Error).message); }
    finally { setPending(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {needsCodeReview && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            This change requires a code-level review (high risk or sensitive paths). A behavior-only approval won&apos;t unblock the merge.
          </AlertDescription>
        </Alert>
      )}

      <div>
        <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Verdict</Label>
        <div className="mt-2 flex gap-2">
          {(["approve", "request_changes", "comment"] as Verdict[]).map(v => (
            <button key={v} type="button" onClick={() => setVerdict(v)}
              className={`px-3 py-1.5 text-xs font-mono rounded border ${verdict === v ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"}`}>
              {v.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      <fieldset>
        <legend className="text-xs font-medium uppercase tracking-wider text-muted-foreground">What did you verify?</legend>
        <div className="mt-2 space-y-1.5">
          {BASES.map(b => {
            const deemphasized = needsCodeReview && b.value === "behavior";
            const selected = basis === b.value;
            return (
              <label
                key={b.value}
                className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-1 -mx-1.5 ${
                  selected ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                } ${deemphasized ? "opacity-50" : ""}`}
              >
                <input
                  type="radio"
                  name="basis"
                  value={b.value}
                  required
                  checked={selected}
                  onChange={() => setBasis(b.value)}
                  className="accent-primary"
                />
                <span>{b.label}</span>
                {deemphasized && <span className="text-[10px] text-muted-foreground">(won&apos;t satisfy the gate)</span>}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div>
        <Label htmlFor="summary" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Summary</Label>
        <Textarea id="summary" value={summary} onChange={e => setSummary(e.target.value)} rows={3} placeholder="Optional — what did you check?" />
      </div>

      {/* Evidence: prove you ran it (#6). Test/CLI output is attached as a
          first-class artifact; a URL becomes a screenshot or a link. */}
      <details className="rounded border border-border/60 px-2 py-1.5">
        <summary className="text-xs font-medium uppercase tracking-wider text-muted-foreground cursor-pointer">Attach evidence (optional)</summary>
        <div className="mt-2 space-y-2">
          <Textarea value={evidenceOutput} onChange={e => setEvidenceOutput(e.target.value)} rows={4}
            placeholder="Paste test or CLI output you ran to verify this — the proof, not just a claim." className="font-mono text-xs" />
          <input type="url" value={evidenceUrl} onChange={e => setEvidenceUrl(e.target.value)}
            placeholder="Screenshot or log URL (optional)"
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
        </div>
      </details>

      <Button type="submit" disabled={pending} size="sm">{pending ? "Submitting…" : "Submit review"}</Button>
    </form>
  );
}
