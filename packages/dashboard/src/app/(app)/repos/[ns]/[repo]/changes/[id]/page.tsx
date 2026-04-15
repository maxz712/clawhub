"use client";

import { useEffect, useState, use } from "react";
import { api, type Change, type MergeDecision, type Review } from "@/lib/api";
import { ChangeMetadataCard } from "@/components/change-metadata-card";
import { FocusedDiffViewer } from "@/components/focused-diff-viewer";
import { ReviewForm } from "@/components/review-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export default function ChangeDetailPage({ params }: { params: Promise<{ ns: string; repo: string; id: string }> }) {
  const { ns, repo, id } = use(params);
  const [change, setChange] = useState<Change | null>(null);
  const [mergeable, setMergeable] = useState<MergeDecision | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [mode, setMode] = useState<"focused" | "full">("focused");
  const [reviews, setReviews] = useState<Review[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  async function load() {
    const [det, rev, d] = await Promise.all([
      api.getChange(ns, repo, id),
      api.listReviews(ns, repo, id),
      api.getDiff(ns, repo, id, mode),
    ]);
    setChange(det.change); setMergeable(det.mergeable);
    setReviews(rev.reviews); setDiff(d.diff);
  }

  useEffect(() => { load().catch(e => setError((e as Error).message)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ns, repo, id]);
  useEffect(() => {
    if (!change) return;
    api.getDiff(ns, repo, id, mode).then(d => setDiff(d.diff)).catch(e => setError((e as Error).message));
  }, [mode, ns, repo, id, change]);

  async function onMerge() {
    setActionPending(true); setError(null);
    try { await api.mergeChange(ns, repo, id); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setActionPending(false); }
  }
  async function onRollback() {
    setActionPending(true); setError(null);
    try { await api.rollbackChange(ns, repo, id); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setActionPending(false); }
  }

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!change || !mergeable) return <div className="text-muted-foreground">Loading…</div>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_20rem] gap-6">
      <div className="space-y-4 min-w-0">
        <FocusedDiffViewer diff={diff} mode={mode} onModeChange={setMode} />
      </div>

      <aside className="space-y-4">
        <ChangeMetadataCard change={change} mergeable={mergeable} />

        <div className="flex gap-2">
          <Button disabled={!mergeable.mergeable || actionPending || change.status === "merged"} onClick={onMerge} className="flex-1">
            {actionPending ? "…" : "Merge"}
          </Button>
          {change.status === "merged" && (
            <Button variant="outline" disabled={actionPending} onClick={onRollback}>Rollback</Button>
          )}
        </div>

        <Card>
          <CardHeader><CardTitle className="text-sm">Reviews ({reviews.length})</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {reviews.length === 0 && <div className="text-sm text-muted-foreground">No reviews yet.</div>}
            {reviews.map(r => (
              <div key={r.id} className="text-sm border-l-2 border-border pl-3">
                <div className="flex items-center gap-2">
                  <Badge variant={r.verdict === "approve" ? "default" : r.verdict === "request_changes" ? "destructive" : "secondary"} className="text-[10px] uppercase">{r.verdict.replace("_", " ")}</Badge>
                  <code className="text-xs font-mono text-muted-foreground">{r.reviewerKind}</code>
                </div>
                {r.summary && <p className="mt-1 text-muted-foreground">{r.summary}</p>}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Submit a review</CardTitle></CardHeader>
          <CardContent>
            <ReviewForm ns={ns} repo={repo} changeId={id} onSubmitted={() => void load()} />
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
