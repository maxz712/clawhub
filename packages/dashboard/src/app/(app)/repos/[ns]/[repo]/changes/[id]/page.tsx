"use client";

import { useCallback, useEffect, useState, use } from "react";
import { api, type Change, type CommentThread, type LinkedIssue, type MergeDecision, type MergeMethod, type MergeReason, type Repo, type Review } from "@/lib/api";
import { EvidencePanel } from "@/components/evidence-panel";
import { DiffReview } from "@/components/diff-review";
import { ReviewForm } from "@/components/review-form";
import { RequestReviewersCard } from "@/components/request-reviewers-card";
import { CommentThreads, Thread } from "@/components/comment-threads";
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
  const [diff, setDiff] = useState<string>("");
  const [linkedIssues, setLinkedIssues] = useState<LinkedIssue[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [method, setMethod] = useState<MergeMethod>("merge");
  const [prefill, setPrefill] = useState<{ path: string; line: number } | null>(null);
  const [rollbackOpen, setRollbackOpen] = useState(false);

  const load = useCallback(async () => {
    // One diff load: the API returns the full parseable diff and <DiffReview>
    // collapses to the flagged lines for the focused view + owns the toggle.
    const [det, repoRes, rev, diffRes, t] = await Promise.all([
      api.getChange(ns, repo, id),
      api.getRepo(ns, repo),
      api.listReviews(ns, repo, id),
      api.getDiff(ns, repo, id, "full"),
      api.listComments(ns, repo, id),
    ]);
    setChange(det.change); setMergeable(det.mergeable); setRepoData(repoRes.repo);
    setReviews(rev.reviews); setDiff(diffRes.diff); setLinkedIssues(det.linkedIssues ?? []);
    setThreads(t.threads);
    // Default the merge method to the repo's preferred/allowed method.
    const allowed = allowedMethods(repoRes.repo);
    setMethod(m => (allowed.includes(m) ? m : allowed[0] ?? "merge"));
  }, [ns, repo, id]);

  useEffect(() => { load().catch(e => setError((e as Error).message)); }, [load]);

  function onSelectLine(path: string, line: number) {
    setPrefill({ path, line });
  }

  // Inline review comments: render the threads anchored to a (path, new-line)
  // directly under that line in the diff. Reuses the same Thread renderer as the
  // Discussion panel, with reply + resolve wired back through `load`.
  const replyToThread = useCallback(async (threadId: string, body: string) => {
    await api.addComment(ns, repo, id, { threadId, body });
    await load();
  }, [ns, repo, id, load]);
  const toggleThreadResolved = useCallback(async (t: CommentThread) => {
    if (t.resolved) await api.unresolveThread(ns, repo, id, t.id);
    else await api.resolveThread(ns, repo, id, t.id);
    await load();
  }, [ns, repo, id, load]);
  const renderLineComments = useCallback((path: string, line: number) => {
    const ts = threads.filter(t => t.path === path && t.line === line && (t.side ?? "new") === "new");
    if (ts.length === 0) return null;
    return (
      <div className="space-y-2">
        {ts.map(t => (
          <Thread key={t.id} thread={t}
            onReply={body => replyToThread(t.id, body)}
            onToggleResolved={() => toggleThreadResolved(t)} />
        ))}
      </div>
    );
  }, [threads, replyToThread, toggleThreadResolved]);

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
  // Guard the request-changes verdict on your own agent's change: it stalls the
  // change with no one-click undo. Runs in the capture phase, before ReviewForm's
  // submit. The selected verdict button is the one styled `border-primary`.
  function confirmRequestChanges(e: React.FormEvent<HTMLDivElement>) {
    const form = e.target as HTMLElement;
    const selected = form instanceof HTMLFormElement
      ? form.querySelector("button[type='button'].border-primary")
      : null;
    if (selected?.textContent?.trim() === "request changes") {
      const ok = window.confirm(
        "Request changes on this change? It stalls the change until the agent pushes a fix — there's no one-click undo. Continue?",
      );
      if (!ok) { e.preventDefault(); e.stopPropagation(); }
    }
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
  // Solo context = USER-namespace repo (single owner). Self-approval of your own
  // agent's work is the EXPECTED flow only here. An org repo is a team context:
  // never tell a teammate that self-approving a colleague's change is fine.
  const solo = repoData?.namespaceType === "user";
  const methods = allowedMethods(repoData);
  // The supervisor CTA: who you are matters — most blocks just need your sign-off.
  const blockReason = !mergeable.mergeable ? (mergeable.reason as MergeReason | undefined) : undefined;
  // Terminal states: a merged or rolled-back change can't be merged again — hide
  // the merge control entirely so only Rollback / post-merge info remains.
  const isTerminal = change.status === "merged" || change.status === "rolled_back";
  // A change that conflicts with the default branch can't merge until the agent
  // rebases — the merge endpoint would fail on click, so block it up front.
  const hasConflicts = change.hasConflicts;
  // Diff-tab counts: file count + how many carry a Review-Focus flag.
  const focusedFiles = new Set((change.reviewFocus ?? []).map(f => f.path));
  const diffFileCount = diff.split("\n").filter(l => l.startsWith("diff --git ")).length;

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

        {/* Linked issues (#13) — the reverse of issue→change linking. */}
        {linkedIssues.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Fixes</span>
            {linkedIssues.map(li => (
              <a key={li.number} href={`/repos/${ns}/${repo}/issues/${li.number}`}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-accent">
                <code className="font-mono text-xs">#{li.number}</code>
                <span className="text-xs text-muted-foreground truncate max-w-[16rem]">{li.title}</span>
                <Badge variant="secondary" className="text-[9px] uppercase">{li.status}</Badge>
              </a>
            ))}
          </div>
        )}

        {/* Evidence-first: outcome evidence leads; the diff is one click away.
            One "Diff" surface — DiffReview owns the Focused/Full toggle and
            collapses to flagged lines by default (#3). */}
        <Tabs defaultValue={focusedFiles.size > 0 ? "diff" : "evidence"}>
          <TabsList variant="line">
            <TabsTrigger value="evidence">Evidence</TabsTrigger>
            <TabsTrigger value="diff">
              Diff{diffFileCount > 0 ? ` · ${diffFileCount} file${diffFileCount === 1 ? "" : "s"}` : ""}
              {focusedFiles.size > 0 ? ` · ${focusedFiles.size} flagged` : ""}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="evidence" className="pt-4">
            <EvidencePanel ns={ns} repo={repo} change={change} mergeable={mergeable} reviews={reviews} solo={solo} />
          </TabsContent>

          <TabsContent value="diff" className="pt-4">
            <DiffReview diff={diff} focus={change.reviewFocus} onLineSelect={onSelectLine} renderLineComments={renderLineComments} />
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
            {/* Supervisor CTA when a human sign-off would unblock the merge. The
                copy branches on context: a solo USER repo gets the
                "self-approval is expected" framing; an org/team repo gets the
                "needs an independent human reviewer" framing — we never tell a
                teammate that self-approving a colleague's change is fine. */}
            {!isTerminal && blockReason && (blockReason === "needs_human_approval" || blockReason === "needs_more_approvals") && (
              <Alert>
                <AlertDescription className="text-sm">
                  {solo ? (
                    <>
                      Submit an <strong>Approve</strong> review below to unblock — self-approving your own agent&apos;s work is expected for solo repos.
                      {blockReason === "needs_human_approval" && (
                        <>
                          {" "}Want your agent to self-approve its own low-risk work without you? Turn on{" "}
                          <a href={`/repos/${ns}/${repo}/settings`} className="font-medium underline underline-offset-2">Solo mode</a>{" "}
                          in Settings (sensitive-path + high-risk still need a human code review).
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      This change needs an approving <strong>code</strong> review from a human other than the author.
                    </>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {/* Merge control — gone once the change reaches a terminal state
                (merged / rolled back); only Rollback + post-merge info remain. */}
            {isTerminal ? (
              <p className="text-xs text-muted-foreground">
                {change.status === "merged" ? "Merged." : "Rolled back."} Nothing left to merge.
              </p>
            ) : (
              <>
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
                    disabled={!mergeable.mergeable || actionPending || hasConflicts || !!change.isDraft}
                    onClick={onMerge}
                  >
                    {actionPending ? "…" : "Merge"}
                  </Button>
                </div>
                {/* Conflicts fail the merge endpoint on click — say so plainly. */}
                {hasConflicts && (
                  <p className="text-xs text-destructive">
                    Branch has conflicts with the default branch — have the agent rebase and push again.
                  </p>
                )}
                {/* The one-line blocker shown right at the point of action. */}
                {!hasConflicts && blockReason && (
                  <p className="text-xs text-muted-foreground">{humanizeMergeReason(blockReason, { solo })}</p>
                )}
              </>
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

        {!isTerminal && (
          <RequestReviewersCard
            ns={ns} repo={repo} changeId={id}
            reviewers={change.requestedReviewers ?? []}
            onChanged={() => void load()}
          />
        )}

        <Card>
          <CardHeader><CardTitle className="text-sm">Submit a review</CardTitle></CardHeader>
          <CardContent>
            {/* Request-changes is a dead-end for solo devs (no easy undo on your
                own agent's work) — confirm before the form's own submit runs.
                onSubmitCapture fires in the capture phase, ahead of ReviewForm's
                onSubmit; cancelling here stops the submit. The selected verdict
                button carries `border-primary`. */}
            <div onSubmitCapture={confirmRequestChanges}>
              <ReviewForm ns={ns} repo={repo} changeId={id} needsCodeReview={needsCodeReview} onSubmitted={() => void load()} />
            </div>
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
