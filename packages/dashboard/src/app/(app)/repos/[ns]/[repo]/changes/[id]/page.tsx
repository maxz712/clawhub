"use client";

import { useEffect, useState, use } from "react";
import { api, type Change, type CommentThread, type MergeDecision, type MergeMethod, type Review } from "@/lib/api";
import { ChangeMetadataCard } from "@/components/change-metadata-card";
import { FocusedDiffViewer } from "@/components/focused-diff-viewer";
import { ReviewForm } from "@/components/review-form";
import { CommentThreads } from "@/components/comment-threads";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function ChangeDetailPage({ params }: { params: Promise<{ ns: string; repo: string; id: string }> }) {
  const { ns, repo, id } = use(params);
  const [change, setChange] = useState<Change | null>(null);
  const [mergeable, setMergeable] = useState<MergeDecision | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [mode, setMode] = useState<"focused" | "full">("focused");
  const [reviews, setReviews] = useState<Review[]>([]);
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [method, setMethod] = useState<MergeMethod>("merge");

  async function load() {
    const [det, rev, d, t] = await Promise.all([
      api.getChange(ns, repo, id),
      api.listReviews(ns, repo, id),
      api.getDiff(ns, repo, id, mode),
      api.listComments(ns, repo, id),
    ]);
    setChange(det.change); setMergeable(det.mergeable);
    setReviews(rev.reviews); setDiff(d.diff);
    setThreads(t.threads);
    // Nothing flagged for focused review — show the full diff instead of an
    // empty pane the reader has to click out of.
    if (mode === "focused" && d.diff.trim() === "") setMode("full");
  }

  useEffect(() => { load().catch(e => setError((e as Error).message)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ns, repo, id]);
  useEffect(() => {
    if (!change) return;
    api.getDiff(ns, repo, id, mode).then(d => setDiff(d.diff)).catch(e => setError((e as Error).message));
  }, [mode, ns, repo, id, change]);

  async function onMerge() {
    setActionPending(true); setError(null);
    try { await api.mergeChange(ns, repo, id, method); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setActionPending(false); }
  }
  async function onRollback() {
    setActionPending(true); setError(null);
    try { await api.rollbackChange(ns, repo, id); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setActionPending(false); }
  }
  async function onToggleDraft() {
    if (!change) return;
    setActionPending(true); setError(null);
    try { await api.markDraft(ns, repo, id, !change.isDraft); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setActionPending(false); }
  }

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!change || !mergeable) return <div className="text-muted-foreground">Loading…</div>;

  const unresolvedCount = threads.filter(t => !t.resolved).length;
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/repos/${ns}/${repo}/changes/${id}` : "";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem] gap-6">
      <div className="space-y-4 min-w-0">
        {change.isDraft && (
          <Alert>
            <AlertDescription>
              <Badge variant="secondary">Draft</Badge>{" "}
              This change is a draft. It cannot be merged until marked ready.
            </AlertDescription>
          </Alert>
        )}
        <FocusedDiffViewer diff={diff} mode={mode} onModeChange={setMode} />

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Discussion ({threads.length} thread{threads.length === 1 ? "" : "s"}
              {unresolvedCount > 0 ? `, ${unresolvedCount} unresolved` : ""})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CommentThreads
              ns={ns} repo={repo} changeId={id} threads={threads}
              onChanged={() => void load()}
            />
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-4">
        <ChangeMetadataCard change={change} mergeable={mergeable} />

        <Card>
          <CardHeader><CardTitle className="text-sm">Actions</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Select value={method} onValueChange={v => setMethod((v ?? "merge") as MergeMethod)}>
                <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="merge">Merge commit</SelectItem>
                  <SelectItem value="squash">Squash &amp; merge</SelectItem>
                  <SelectItem value="rebase">Rebase &amp; merge</SelectItem>
                </SelectContent>
              </Select>
              <Button
                disabled={!mergeable.mergeable || actionPending || change.status === "merged" || !!change.isDraft}
                onClick={onMerge}
              >
                {actionPending ? "…" : "Merge"}
              </Button>
            </div>
            <div className="flex gap-2">
              {change.status !== "merged" && change.status !== "rolled_back" && (
                <Button variant="outline" disabled={actionPending} onClick={onToggleDraft} className="flex-1">
                  {change.isDraft ? "Mark ready" : "Convert to draft"}
                </Button>
              )}
              {change.status === "merged" && (
                <Button variant="outline" disabled={actionPending} onClick={onRollback} className="flex-1">Rollback</Button>
              )}
            </div>
            {shareUrl && (
              <div className="pt-2 border-t border-border space-y-2">
                <div className="text-xs text-muted-foreground font-mono">Share</div>
                <img src={api.changeOgUrl(ns, repo, id)} alt="Change preview" className="rounded border border-border w-full" />
                <button
                  onClick={() => void navigator.clipboard.writeText(shareUrl)}
                  className="text-xs font-mono underline text-muted-foreground hover:text-foreground"
                >
                  Copy share URL
                </button>
              </div>
            )}
          </CardContent>
        </Card>

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
