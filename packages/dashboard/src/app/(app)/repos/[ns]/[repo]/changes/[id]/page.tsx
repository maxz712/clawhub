"use client";

import { useCallback, useEffect, useRef, useState, use } from "react";
import { api, type Change, type CiRun, type CommentThread, type LinkedIssue, type MergeDecision, type MergeMethod, type Repo, type RepoAccess, type Review, type ReviewFocus, type Verdict, type VerificationRun } from "@/lib/api";
import { DiffReview } from "@/components/diff-review";
import { ChangeStatusStrip } from "@/components/change-status-strip";
import { ReviewMergePanel } from "@/components/review-merge-panel";
import { RequestReviewersCard } from "@/components/request-reviewers-card";
import { CommentThreads, Thread, useAuthorResolver } from "@/components/comment-threads";
import { Breadcrumb } from "@/components/breadcrumb";
import { useDocumentTitle } from "@/lib/use-document-title";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { GitFork, Pencil, RotateCw } from "lucide-react";

const ALL_METHODS: MergeMethod[] = ["merge", "squash", "rebase"];

export default function ChangeDetailPage({ params }: { params: Promise<{ ns: string; repo: string; id: string }> }) {
  const { ns, repo, id } = use(params);
  const [change, setChange] = useState<Change | null>(null);
  const [repoData, setRepoData] = useState<Repo | null>(null);
  // The caller's access level on this repo — gates whether the panel offers
  // merge actions (write+) vs review-only.
  const [viewerAccess, setViewerAccess] = useState<RepoAccess>("read");
  const [mergeable, setMergeable] = useState<MergeDecision | null>(null);
  const [behindBase, setBehindBase] = useState(false);
  const [diff, setDiff] = useState<string>("");
  // Merged, source-tagged focus (author + derived Review Brief + reviewer) from
  // the diff endpoint — the "wire the dead pipe" union, not just author flags.
  const [diffFocus, setDiffFocus] = useState<ReviewFocus[]>([]);
  const [linkedIssues, setLinkedIssues] = useState<LinkedIssue[]>([]);
  const [verification, setVerification] = useState<VerificationRun | null>(null);
  // This change's CI runs — the strip's CI row links each to the exact run on
  // the CI tab (?run=<id>). Null while loading.
  const [ciRuns, setCiRuns] = useState<CiRun[] | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [prefill, setPrefill] = useState<{ path: string; line: number } | null>(null);
  // Whether the reviewer saw past the focused view (Expand all / Full diff) —
  // recorded on review submissions so a code-basis approval is honest about
  // what was actually read (v3 P5).
  const [viewedFullDiff, setViewedFullDiff] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [abandonReason, setAbandonReason] = useState("");
  // Inline edit of the Change description (intent). At push time it comes from
  // the commit `Intent:` trailer and is otherwise frozen — this is the edit path.
  const [editingIntent, setEditingIntent] = useState(false);
  const [intentDraft, setIntentDraft] = useState("");
  const [intentSaving, setIntentSaving] = useState(false);
  // Cross-repo proposal (fork → upstream): dialog state + the existing proposal.
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposePending, setProposePending] = useState(false);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [target, setTarget] = useState<{ targetNs: string; targetRepo: string; targetBranch: string }>({ targetNs: "", targetRepo: "", targetBranch: "" });
  const [proposal, setProposal] = useState<{ id: string; targetRepoId: string; targetBranch: string; status: string } | null>(null);
  // Resolve comment-author ids → names for the inline diff threads (mirrors the
  // Discussion panel, which builds its own resolver).
  const resolveAuthor = useAuthorResolver();

  const load = useCallback(async () => {
    // One diff load: the API returns the full parseable diff and <DiffReview>
    // collapses to the flagged lines for the focused view + owns the toggle.
    const [det, repoRes, rev, diffRes, t, ci] = await Promise.all([
      api.getChange(ns, repo, id),
      api.getRepo(ns, repo),
      api.listReviews(ns, repo, id),
      api.getDiff(ns, repo, id, "full"),
      api.listComments(ns, repo, id),
      // Best-effort: the strip's CI row links to exact runs when these resolve.
      api.listCiRuns(ns, repo, id).catch(() => ({ runs: [] as CiRun[] })),
    ]);
    setChange(det.change); setMergeable(det.mergeable); setBehindBase(det.behindBase ?? false); setRepoData(repoRes.repo); setViewerAccess(repoRes.access);
    setVerification(det.verification ?? null);
    setCiRuns(ci.runs);
    setReviews(rev.reviews); setDiff(diffRes.diff); setDiffFocus(diffRes.focus ?? []); setLinkedIssues(det.linkedIssues ?? []);
    setThreads(t.threads);
    // Surface any existing cross-repo proposal for this change (forks only).
    if (repoRes.repo.forkOfRepoId) {
      api.getChangeProposal(ns, repo, id).then(p => setProposal(p.proposal)).catch(() => {});
    }
  }, [ns, repo, id]);

  useEffect(() => { load().catch(e => setError((e as Error).message)); }, [load]);

  // Tripwire retrofit (M8): fire the review-brief funnel event once, when the
  // change first loads with derived content (the strip's Focus row renders it).
  const briefFired = useRef(false);
  useEffect(() => {
    if (!change || briefFired.current) return;
    briefFired.current = true;
    if ((change.reviewBrief?.derivedFocus?.length ?? 0) > 0 || (change.reviewBrief?.callouts?.length ?? 0) > 0) void api.telemetry("review_brief_rendered");
  }, [change]);

  // Advisory + verification funnel events (once each, when they first appear).
  const advFired = useRef(false), verFired = useRef(false);
  useEffect(() => { if (!advFired.current && reviews.some(r => r.advisory)) { advFired.current = true; void api.telemetry("advisory_shown"); } }, [reviews]);
  useEffect(() => { if (!verFired.current && verification) { verFired.current = true; void api.telemetry("verification_shown"); } }, [verification]);

  // Stay live: CI status + mergeability can flip while you watch. Re-fetch when a
  // relevant event for THIS change lands (debounced), instead of forcing a manual
  // reload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const es = new EventSource(api.eventStreamUrl({ replay: false }));
    let t: ReturnType<typeof setTimeout> | null = null;
    const onEvt = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as { changeId?: string };
        if (parsed.changeId !== id) return;
        if (t) clearTimeout(t);
        t = setTimeout(() => { load().catch(() => {}); }, 600);
      } catch { /* ignore */ }
    };
    ["ci.completed", "ci.running", "review.submitted", "change.updated", "change.merged", "comment.created", "comment.resolved"].forEach(ev => es.addEventListener(ev, onEvt));
    return () => { if (t) clearTimeout(t); es.close(); };
  }, [id, load]);

  async function onReopen() {
    setActionPending(true); setError(null);
    try { await api.reopenChange(ns, repo, id); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setActionPending(false); }
  }

  function onSelectLine(path: string, line: number) {
    setPrefill({ path, line });
  }

  // Deep-link from a strip row (brief decision / advisory finding) into the
  // diff: scroll the file card into view (the feed is one page — no tabs).
  function onJumpToDecision(path: string, _line: number) {
    document.getElementById(`diff-file-${path}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Opt this repo out of the native advisory reviewer (M4) from the advisory card.
  async function onDisableAdvisory() {
    try { await api.patchRepo(ns, repo, { nativeReviewerEnabled: false }); await load(); }
    catch (e) { setError((e as Error).message); }
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
            onToggleResolved={() => toggleThreadResolved(t)}
            resolveAuthor={resolveAuthor} />
        ))}
      </div>
    );
  }, [threads, replyToThread, toggleThreadResolved, resolveAuthor]);

  async function onRollback() {
    setRollbackOpen(false);
    setActionPending(true); setError(null);
    try { await api.rollbackChange(ns, repo, id); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setActionPending(false); }
  }
  async function onAbandon() {
    setAbandonOpen(false);
    setActionPending(true); setError(null);
    try { await api.abandonChange(ns, repo, id, abandonReason.trim() || undefined); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setActionPending(false); }
  }
  function openProposeDialog() {
    setProposeError(null);
    setProposeOpen(true);
    setTarget(t => ({ ...t, targetBranch: t.targetBranch || repoData?.defaultBranch || "main" }));
  }
  async function onPropose() {
    setProposePending(true); setProposeError(null);
    try {
      await api.proposeCrossRepo(ns, repo, id, {
        targetNs: target.targetNs.trim(),
        targetRepo: target.targetRepo.trim(),
        targetBranch: target.targetBranch.trim() || repoData?.defaultBranch || "main",
      });
      const p = await api.getChangeProposal(ns, repo, id);
      setProposal(p.proposal);
      setProposeOpen(false);
    } catch (e) {
      setProposeError((e as Error).message);
    } finally {
      setProposePending(false);
    }
  }
  async function onToggleDraft() {
    if (!change) return;
    setActionPending(true); setError(null);
    try { await api.markDraft(ns, repo, id, !change.isDraft); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setActionPending(false); }
  }
  function startEditIntent() {
    setIntentDraft(change?.intent ?? "");
    setEditingIntent(true);
  }
  function cancelEditIntent() {
    setEditingIntent(false);
    setIntentDraft("");
  }
  async function onSaveIntent() {
    const next = intentDraft.trim();
    if (!next) return;
    setIntentSaving(true); setError(null);
    try {
      const det = await api.updateChangeIntent(ns, repo, id, next);
      setChange(det.change); setMergeable(det.mergeable); setLinkedIssues(det.linkedIssues ?? []);
      setEditingIntent(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIntentSaving(false);
    }
  }
  // Guard the request-changes verdict on your own agent's change: it stalls the
  // change with no one-click undo. Keyed off the REAL selected verdict value
  // (not DOM text or a Tailwind class), run by ReviewMergePanel before it
  // submits; returning false cancels the submit.
  function confirmReviewSubmit(verdict: Verdict): boolean {
    if (verdict !== "request_changes") return true;
    return window.confirm(
      "Request changes on this change? It stalls the change until the agent pushes a fix — there's no one-click undo. Continue?",
    );
  }

  useDocumentTitle(change ? `${change.intent || change.branch} · ${ns}/${repo}` : undefined);

  // On any load failure the persistent repo header (from the layout) keeps the
  // user oriented; a breadcrumb adds the path back to the change list.
  if (!change || !mergeable) {
    return (
      <div className="space-y-6">
        <Breadcrumb items={[{ label: "Changes", href: `/repos/${ns}/${repo}/changes` }, { label: "Change" }]} />
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
  // Prefer the explicit codeReviewRequired flag: it's true from the FIRST view
  // (while the reason is still `needs_human_approval`), so the basis radio
  // defaults to "code" and the reviewer doesn't waste a behavior approval that
  // silently won't count. Fall back to the reason for older API responses.
  const needsCodeReview = mergeable.codeReviewRequired ?? (mergeable.reason === "needs_code_review");
  // Solo context = USER-namespace repo (single owner). Self-approval of your own
  // agent's work is the EXPECTED flow only here. An org repo is a team context:
  // never tell a teammate that self-approving a colleague's change is fine.
  const solo = repoData?.namespaceType === "user";
  const methods = allowedMethods(repoData);
  // Terminal states: a merged or rolled-back change can't be merged again — the
  // ReviewMergePanel is hidden, so only Rollback / post-merge info remains.
  const isTerminal = change.status === "merged" || change.status === "rolled_back" || change.status === "abandoned";
  // A change that conflicts with the default branch can't merge until the agent
  // rebases — the merge endpoint would fail on click, so block it up front.
  const hasConflicts = change.hasConflicts;
  // The merged, source-tagged focus union (author + derived + reviewer) —
  // drives both the strip's Focus row and the diff's inline flags.
  const focusUnion = diffFocus.length ? diffFocus : (change.reviewFocus ?? []);
  // The native reviewer's CURRENT advisory findings, rendered inline in the
  // diff with a distinct "advisory" style. Superseded reviews are dropped
  // server-side on a new head, so the latest advisory row matches this head.
  const latestAdvisory = reviews.filter(r => r.advisory).sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))[0];
  const advisoryFocus = (latestAdvisory?.contract?.additionalFocus ?? []).map(f => ({
    path: f.path, startLine: f.startLine, endLine: f.endLine, note: f.reason,
  }));

  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: "Changes", href: `/repos/${ns}/${repo}/changes` }, { label: change.intent || change.branch }]} />
      {/* Identity line: status + author + branch. Risk moved into the status
          strip's always-visible first row (one home, not two). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <StatusBadge status={change.status} />
        <span>
          by <span className="font-mono text-foreground">@{change.openedByUserName ?? change.openedByAgentName ?? "unknown"}</span>
        </span>
        <span className="font-mono truncate max-w-[32ch]">{change.branch}</span>
      </div>
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
        {/* Description (intent) — set at push from the commit `Intent:` trailer,
            then editable here. Editing description metadata is not a git commit,
            so a human supervisor may refine it without breaking "only agents
            commit". */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm">Description</CardTitle>
              {!editingIntent && !isTerminal && (
                <Button variant="ghost" size="icon-sm" className="ml-auto" title="Edit description"
                  aria-label="Edit description" onClick={startEditIntent}>
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {editingIntent ? (
              <div className="space-y-2">
                <Textarea value={intentDraft} onChange={e => setIntentDraft(e.target.value)} rows={3}
                  maxLength={10000} disabled={intentSaving} autoFocus
                  placeholder="Describe what this change does" />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={cancelEditIntent} disabled={intentSaving}>Cancel</Button>
                  <Button size="sm" onClick={onSaveIntent} disabled={intentSaving || !intentDraft.trim()}>
                    {intentSaving ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
            ) : change.intent ? (
              <div className="space-y-2">
                <p className="text-sm whitespace-pre-wrap break-words">{change.intent}</p>
                {/* Prose body from the commit messages (trailers stripped), captured
                    at push. Distinct from the one-line intent above. */}
                {change.description && (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words border-t border-border pt-2">{change.description}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">No description.</p>
            )}
          </CardContent>
        </Card>

        {/* The compact status strip (v3 P5, v4 dedupe) — one line per signal
            (risk · CI · focus · verification · advisory · reviews · scope),
            each signal in exactly ONE row. The CI chip + expansion link to the
            exact runs on the CI tab (?run=<id>). */}
        <ChangeStatusStrip
          ns={ns} repo={repo} change={change}
          reviews={reviews} verification={verification} focus={focusUnion} ciRuns={ciRuns}
          onJump={onJumpToDecision} onDisableAdvisory={onDisableAdvisory}
        />

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

        {/* ONE feed: the diff opens in FOCUSED mode right here — no tabs. The
            merged, source-tagged focus comes from the diff endpoint; files
            render in the Review Brief's churn × sensitivity order; unflagged
            files auto-collapse to header rows; advisory findings annotate
            inline in a distinct style. Expanding everything (or switching to
            Full diff) is recorded on review submissions (viewedFullDiff). */}
        <DiffReview diff={diff} focus={diffFocus} advisoryFocus={advisoryFocus}
          onLineSelect={onSelectLine} renderLineComments={renderLineComments}
          fileOrder={(change.reviewBrief?.files ?? []).map(f => f.path)}
          onFullView={() => setViewedFullDiff(true)} />

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
        {/* Primary action surface: ONE panel for the review→merge handoff. It
            reads the gate + the caller's access and offers the single most
            useful action (Approve / Approve & merge / Merge) instead of the old
            split between a merge control and a separate review form. */}
        {!isTerminal && (
          <ReviewMergePanel
            ns={ns} repo={repo} changeId={id}
            isDraft={!!change.isDraft}
            hasConflicts={hasConflicts}
            behindBase={behindBase}
            mergeable={mergeable}
            viewerAccess={viewerAccess}
            methods={methods}
            needsCodeReview={needsCodeReview}
            solo={solo}
            armed={!!change.autoMerge?.enabled && change.autoMerge?.armedAtCommit === change.headCommit}
            settingsHref={`/repos/${ns}/${repo}/settings?tab=policy`}
            confirmBeforeSubmit={confirmReviewSubmit}
            viewedFullDiff={viewedFullDiff}
            onDone={() => void load()}
          />
        )}

        {!isTerminal && (
          <RequestReviewersCard
            ns={ns} repo={repo} changeId={id}
            reviewers={change.requestedReviewers ?? []}
            onChanged={() => void load()}
          />
        )}

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-sm">Actions</CardTitle>
              <StatusBadge status={change.status} />
              {change.hasConflicts && <Badge className="font-medium uppercase tracking-wider text-[10px] bg-destructive/15 text-destructive border border-destructive/30">conflicts</Badge>}
              <Button variant="ghost" size="icon-sm" className="ml-auto" title="Refresh" aria-label="Refresh"
                disabled={actionPending} onClick={() => { setError(null); load().catch(e => setError((e as Error).message)); }}>
                <RotateCw className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Terminal states: merge/review live in the panel above (hidden when
                terminal); here only the post-merge note + Rollback remain. */}
            {isTerminal && (
              <p className="text-xs text-muted-foreground">
                {change.status === "merged" ? "Merged." : change.status === "abandoned" ? "Abandoned — closed without merging." : "Rolled back."} Nothing left to merge.
              </p>
            )}
            {/* Undo a mis-clicked "request changes", or un-abandon a diff — both
                return the change to pending. (confirm()-only had no recovery.) */}
            {(change.status === "changes_requested" || change.status === "abandoned") && (
              <Button variant="outline" disabled={actionPending} onClick={onReopen} className="w-full">
                {actionPending ? "…" : change.status === "abandoned" ? "Reopen (un-abandon)" : "Reopen (dismiss request changes)"}
              </Button>
            )}
            <div className="flex gap-2">
              {!isTerminal && (
                <Button variant="outline" disabled={actionPending} onClick={onToggleDraft} className="flex-1">
                  {change.isDraft ? "Mark ready" : "Convert to draft"}
                </Button>
              )}
              {!isTerminal && (
                <Button variant="outline" disabled={actionPending} onClick={() => setAbandonOpen(true)} className="flex-1" title="Close this diff without merging (reopenable)">Abandon</Button>
              )}
              {change.status === "merged" && (
                <Button variant="outline" disabled={actionPending} onClick={() => setRollbackOpen(true)} className="flex-1">Rollback</Button>
              )}
            </div>
            {/* Cross-repo proposal: only forks can propose their change upstream. */}
            {repoData?.forkOfRepoId && (
              <div className="pt-2 border-t border-border space-y-2">
                <Button variant="outline" onClick={openProposeDialog} className="w-full gap-1.5">
                  <GitFork className="h-4 w-4" /> Propose to upstream
                </Button>
                {proposal && (
                  <p className="text-xs text-muted-foreground">
                    Proposed to <code className="font-mono">{proposal.targetBranch}</code> ·{" "}
                    <Badge variant="secondary" className="text-[9px] uppercase">{proposal.status}</Badge>
                  </p>
                )}
              </div>
            )}
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
      </aside>
    </div>

    <Dialog open={proposeOpen} onOpenChange={setProposeOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Propose to upstream</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Open this change as a cross-repo proposal against an upstream repo. A maintainer there accepts it to
          materialize a reviewable Change.
        </p>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="target-ns">Target namespace</Label>
            <Input id="target-ns" value={target.targetNs} placeholder="upstream-owner"
              onChange={e => setTarget(t => ({ ...t, targetNs: e.target.value }))} disabled={proposePending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="target-repo">Target repo</Label>
            <Input id="target-repo" value={target.targetRepo} placeholder={repo}
              onChange={e => setTarget(t => ({ ...t, targetRepo: e.target.value }))} disabled={proposePending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="target-branch">Target branch</Label>
            <Input id="target-branch" value={target.targetBranch} placeholder={repoData?.defaultBranch || "main"}
              onChange={e => setTarget(t => ({ ...t, targetBranch: e.target.value }))} disabled={proposePending} />
          </div>
          {proposeError && <p className="text-xs text-destructive">{proposeError}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setProposeOpen(false)}>Cancel</Button>
          <Button onClick={onPropose}
            disabled={proposePending || !target.targetNs.trim() || !target.targetRepo.trim()}>
            {proposePending ? "Proposing…" : "Propose"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

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

    <Dialog open={abandonOpen} onOpenChange={setAbandonOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Abandon this change?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Closes this diff without merging — it leaves the review queue and can no longer be merged. Nothing is pushed or reverted. You can reopen it later.
        </p>
        <Textarea value={abandonReason} onChange={e => setAbandonReason(e.target.value)} rows={2}
          placeholder="Reason (optional) — e.g. superseded, wrong approach" />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setAbandonOpen(false)}>Cancel</Button>
          <Button variant="destructive" onClick={onAbandon} disabled={actionPending}>{actionPending ? "Abandoning…" : "Abandon"}</Button>
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
