"use client";

import { useCallback, useEffect, useState, use } from "react";
import { api, type Change, type CommentThread, type MergeDecision, type MergeMethod, type MergeReason, type Repo, type Review } from "@/lib/api";
import { EvidencePanel } from "@/components/evidence-panel";
import { DiffReview } from "@/components/diff-review";
import { ReviewForm } from "@/components/review-form";
import { CommentThreads } from "@/components/comment-threads";
import { RepoHeader } from "@/components/repo-header";
import { StatusBadge } from "@/components/status-badge";
import { humanizeMergeReason } from "@/lib/merge-reason";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL_METHODS: MergeMethod[] = ["merge", "squash", "rebase"];
const METHOD_LABEL: Record<MergeMethod, string> = { merge: "Merge commit", squash: "Squash & merge", rebase: "Rebase & merge" };

export default function ChangeDetailPage({ params }: { params: Promise<{ ns: string; repo: string; id: string }> }) {
  const { ns, repo, id } = use(params);
  const [change, setChange] = useState<Change | null>(null);
  const [repoData, setRepoData] = useState<Repo | null>(null);
  const [mergeable, setMergeable] = useState<MergeDecision | null>(null);
  const [focusedDiff, setFocusedDiff] = useState<string>("");
  const [fullDiff, setFullDiff] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [method, setMethod] = useState<MergeMethod>("merge");
  const [prefill, setPrefill] = useState<{ path: string; line: number } | null>(null);
  const [rollbackOpen, setRollbackOpen] = useState(false);

  const load = useCallback(async () => {
    // Full diff is deferred until the user opens the Full-diff tab (see
    // loadFullDiff) — only the focused diff + evidence load on mount.
    const [det, repoRes, rev, focused, t] = await Promise.all([
      api.getChange(ns, repo, id),
      api.getRepo(ns, repo),
      api.listReviews(ns, repo, id),
      api.getDiff(ns, repo, id, "focused"),
      api.listComments(ns, repo, id),
    ]);
    setChange(det.change); setMergeable(det.mergeable); setRepoData(repoRes.repo);
    setReviews(rev.reviews); setFocusedDiff(focused.diff);
    setThreads(t.threads);
    // Default the merge method to the repo's preferred/allowed method.
    const allowed = allowedMethods(repoRes.repo);
    setMethod(m => (allowed.includes(m) ? m : allowed[0] ?? "merge"));
  }, [ns, repo, id]);

  const loadFullDiff = useCallback(() => {
    if (fullDiff !== null) return;
    api.getDiff(ns, repo, id, "full").then(r => setFullDiff(r.diff)).catch(e => setError((e as Error).message));
  }, [ns, repo, id, fullDiff]);

  useEffect(() => { load().catch(e => setError((e as Error).message)); }, [load]);

  function onSelectLine(path: string, line: number) {
    setPrefill({ path, line });
  }

  async function onMerge() {
    setActionPending(true); setError(null);
    try { await api.mergeChange(ns, repo, id, method); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setActionPending(false); }
  }
  async function onRollback() {
    setRollbackOpen(false);
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

  // On any load failure keep the repo nav so the user doesn't lose context.
  if (!change || !mergeable) {
    return (
      <div className="space-y-6">
        <RepoHeader ns={ns} repo={repo} data={repoData} />
        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>{error}</span>
              <Button size="sm" variant="outline" onClick={() => { setError(null); load().catch(e => setError((e as Error).message)); }}>Retry</Button>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="text-muted-foreground">Loading…</div>
        )}
      </div>
    );
  }

  const unresolvedCount = threads.filter(t => !t.resolved).length;
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/repos/${ns}/${repo}/changes/${id}` : "";
  const needsCodeReview = mergeable.reason === "needs_code_review";
  const hasFocus = change.reviewFocus.length > 0;
  const methods = allowedMethods(repoData);
  // The supervisor CTA: who you are matters — most blocks just need your sign-off.
  const blockReason = !mergeable.mergeable ? (mergeable.reason as MergeReason | undefined) : undefined;

  return (
    <div className="space-y-6">
      <RepoHeader ns={ns} repo={repo} data={repoData} />
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => setError(null)}>Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}
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
        <Tabs defaultValue="evidence" onValueChange={v => { if (v === "full") loadFullDiff(); }}>
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
              <DiffReview diff={focusedDiff} focus={change.reviewFocus} onLineSelect={onSelectLine} />
            ) : (
              <Card>
                <CardContent className="py-6 text-sm text-muted-foreground">
                  No lines were flagged for focused review. Open the full diff to read everything.
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="full" className="pt-4">
            {fullDiff === null ? (
              <div className="text-sm text-muted-foreground">Loading full diff…</div>
            ) : (
              <DiffReview diff={fullDiff} focus={change.reviewFocus} onLineSelect={onSelectLine} />
            )}
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
              prefill={prefill}
              onChanged={() => void load()}
            />
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-sm">Actions</CardTitle>
              <StatusBadge status={change.status} />
              {change.hasConflicts && <Badge className="font-medium uppercase tracking-wider text-[10px] bg-destructive/15 text-destructive border border-destructive/30">conflicts</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Supervisor CTA when a human sign-off would unblock the merge. */}
            {blockReason && (blockReason === "needs_human_approval" || blockReason === "needs_more_approvals") && (
              <Alert>
                <AlertDescription className="text-sm">
                  You&apos;re the supervisor — approve your agent&apos;s change below as the human to unblock the merge
                  {" "}(self-approving your own agent&apos;s work is expected for solo repos).
                  {blockReason === "needs_human_approval" && (
                    <>
                      {" "}A team of one? Turn on{" "}
                      <a href={`/repos/${ns}/${repo}/settings`} className="font-medium underline underline-offset-2">Solo mode</a>{" "}
                      in Settings so your own approval counts on low/medium changes.
                    </>
                  )}
                </AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Select value={method} onValueChange={v => setMethod((v ?? methods[0] ?? "merge") as MergeMethod)}>
                <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ALL_METHODS.map(m => (
                    <SelectItem key={m} value={m} disabled={!methods.includes(m)}>{METHOD_LABEL[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                disabled={!mergeable.mergeable || actionPending || change.status === "merged" || !!change.isDraft}
                onClick={onMerge}
              >
                {actionPending ? "…" : "Merge"}
              </Button>
            </div>
            {/* The one-line blocker shown right at the point of action. */}
            {blockReason && (
              <p className="text-xs text-muted-foreground">{humanizeMergeReason(blockReason)}</p>
            )}
            <div className="flex gap-2">
              {change.status !== "merged" && change.status !== "rolled_back" && (
                <Button variant="outline" disabled={actionPending} onClick={onToggleDraft} className="flex-1">
                  {change.isDraft ? "Mark ready" : "Convert to draft"}
                </Button>
              )}
              {change.status === "merged" && (
                <Button variant="outline" disabled={actionPending} onClick={() => setRollbackOpen(true)} className="flex-1">Rollback</Button>
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

    <Dialog open={rollbackOpen} onOpenChange={setRollbackOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Roll back this change?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          This creates a revert commit on the default branch, undoing the merged change. This can&apos;t be undone with one click.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRollbackOpen(false)}>Cancel</Button>
          <Button variant="destructive" onClick={onRollback} disabled={actionPending}>{actionPending ? "Rolling back…" : "Roll back"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </div>
  );
}

/**
 * The merge methods a repo allows. Prefers an explicit allowlist if the policy
 * carries one (defaultMergeMethod / allowedMergeMethods), otherwise all three.
 */
function allowedMethods(repo: Repo | null): MergeMethod[] {
  const policy = repo?.mergePolicy as (Repo["mergePolicy"] & { allowedMergeMethods?: MergeMethod[]; defaultMergeMethod?: MergeMethod }) | undefined;
  const allowed = policy?.allowedMergeMethods;
  if (Array.isArray(allowed) && allowed.length > 0) {
    const ordered = ALL_METHODS.filter(m => allowed.includes(m));
    return ordered.length ? ordered : ALL_METHODS;
  }
  const dflt = policy?.defaultMergeMethod;
  if (dflt && ALL_METHODS.includes(dflt)) {
    return [dflt, ...ALL_METHODS.filter(m => m !== dflt)];
  }
  return ALL_METHODS;
}
