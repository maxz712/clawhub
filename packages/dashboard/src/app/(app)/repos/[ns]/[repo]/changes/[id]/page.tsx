"use client";

import { useEffect, useState, use } from "react";
import { api, type Change, type CommentThread, type MergeDecision, type MergeMethod, type Review } from "@/lib/api";
import { EvidencePanel } from "@/components/evidence-panel";
import { DiffReview } from "@/components/diff-review";
import { ReviewForm } from "@/components/review-form";
import { CommentThreads } from "@/components/comment-threads";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function ChangeDetailPage({ params }: { params: Promise<{ ns: string; repo: string; id: string }> }) {
  const { ns, repo, id } = use(params);
  const [change, setChange] = useState<Change | null>(null);
  const [mergeable, setMergeable] = useState<MergeDecision | null>(null);
  const [focusedDiff, setFocusedDiff] = useState<string>("");
  const [fullDiff, setFullDiff] = useState<string>("");
  const [reviews, setReviews] = useState<Review[]>([]);
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [method, setMethod] = useState<MergeMethod>("merge");

  async function load() {
    const [det, rev, focused, full, t] = await Promise.all([
      api.getChange(ns, repo, id),
      api.listReviews(ns, repo, id),
      api.getDiff(ns, repo, id, "focused"),
      api.getDiff(ns, repo, id, "full"),
      api.listComments(ns, repo, id),
    ]);
    setChange(det.change); setMergeable(det.mergeable);
    setReviews(rev.reviews); setFocusedDiff(focused.diff); setFullDiff(full.diff);
    setThreads(t.threads);
  }

  useEffect(() => { load().catch(e => setError((e as Error).message)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ns, repo, id]);

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
  const needsCodeReview = mergeable.reason === "needs_code_review";
  const hasFocus = change.reviewFocus.length > 0;

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

        {/* Evidence-first: outcome evidence leads; the diff is one click away. */}
        <Tabs defaultValue="evidence">
          <TabsList variant="line">
            <TabsTrigger value="evidence">Evidence</TabsTrigger>
            <TabsTrigger value="focused">Focused diff</TabsTrigger>
            <TabsTrigger value="full">Full diff</TabsTrigger>
          </TabsList>

          <TabsContent value="evidence" className="pt-4">
            <EvidencePanel ns={ns} repo={repo} change={change} mergeable={mergeable} reviews={reviews} />
          </TabsContent>

          <TabsContent value="focused" className="pt-4">
            {hasFocus ? (
              <DiffReview diff={focusedDiff} focus={change.reviewFocus} />
            ) : (
              <Card>
                <CardContent className="py-6 text-sm text-muted-foreground">
                  No lines were flagged for focused review. Open the full diff to read everything.
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="full" className="pt-4">
            <DiffReview diff={fullDiff} focus={change.reviewFocus} />
          </TabsContent>
        </Tabs>

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
        <Card>
          <CardHeader>
            <CardTitle className="text-base leading-snug">{change.intent || "(no intent declared)"}</CardTitle>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <StatusBadge status={change.status} />
              {change.hasConflicts && <Badge className="font-medium uppercase tracking-wider text-[10px] bg-destructive/15 text-destructive border border-destructive/30">conflicts</Badge>}
            </div>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Full evidence — risk, CI, and reviews — is in the <span className="text-foreground">Evidence</span> tab.
          </CardContent>
        </Card>

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
                <img src={api.changeOgUrl(ns, repo, id)} alt="Change preview" className="rounded border border-border w-full" onError={e => { (e.target as HTMLImageElement).closest("div")!.style.display = "none"; }} />
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
          <CardHeader><CardTitle className="text-sm">Submit a review</CardTitle></CardHeader>
          <CardContent>
            <ReviewForm ns={ns} repo={repo} changeId={id} needsCodeReview={needsCodeReview} onSubmitted={() => void load()} />
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
