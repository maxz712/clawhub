"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api, type Verdict } from "@/lib/api";

export function ReviewForm({ ns, repo, changeId, onSubmitted }: { ns: string; repo: string; changeId: string; onSubmitted: () => void }) {
  const [verdict, setVerdict] = useState<Verdict>("approve");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true); setError(null);
    try {
      await api.submitReview(ns, repo, changeId, { verdict, summary: summary || undefined });
      setSummary("");
      onSubmitted();
    } catch (err) { setError((err as Error).message); }
    finally { setPending(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
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
      <div>
        <Label htmlFor="summary" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Summary</Label>
        <Textarea id="summary" value={summary} onChange={e => setSummary(e.target.value)} rows={3} placeholder="Optional — what did you check?" />
      </div>
      <Button type="submit" disabled={pending} size="sm">{pending ? "Submitting…" : "Submit review"}</Button>
    </form>
  );
}
