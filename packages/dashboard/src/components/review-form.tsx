"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api, type ReviewBasis, type Verdict } from "@/lib/api";
import { Info } from "lucide-react";

const BASES: Array<{ value: ReviewBasis; label: string }> = [
  { value: "behavior", label: "Verified the behavior" },
  { value: "code", label: "Reviewed the code" },
  { value: "both", label: "Both" },
];

export function ReviewForm({
  ns, repo, changeId, needsCodeReview = false, onSubmitted,
}: {
  ns: string; repo: string; changeId: string; needsCodeReview?: boolean; onSubmitted: () => void;
}) {
  const [verdict, setVerdict] = useState<Verdict>("approve");
  // Default to the basis that satisfies the gate when code review is required.
  const [basis, setBasis] = useState<ReviewBasis>(needsCodeReview ? "code" : "behavior");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true); setError(null);
    try {
      await api.submitReview(ns, repo, changeId, { verdict, basis, summary: summary || undefined });
      setSummary("");
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
      <Button type="submit" disabled={pending} size="sm">{pending ? "Submitting…" : "Submit review"}</Button>
    </form>
  );
}
