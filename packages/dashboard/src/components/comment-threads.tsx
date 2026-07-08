"use client";

import { useEffect, useRef, useState } from "react";
import { api, type CommentThread, type WorkflowDispatch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SlashCommandHint, WorkflowDispatchNotice, isSlashCommandDraft } from "@/components/slash-command-hint";

// Resolves a comment author (kind + id) to a human-friendly label. Agents are
// resolved by id → name via the agents list; the only human we can resolve by
// id client-side is the signed-in user (no general user-by-id lookup), so other
// humans get a stable placeholder rather than a raw UUID slice.
export type AuthorResolver = (authorKind: "agent" | "human", authorId: string) => string;

/**
 * Builds an author-id → display-name resolver. Loads the agents list once for
 * agent names and the signed-in user for the one human we can name by id. Never
 * surfaces a raw UUID: an unresolved agent → "agent", an unresolved human → the
 * signed-in user's @handle when it's them, otherwise a stable "reviewer".
 * Falls back gracefully if either fetch fails.
 */
export function useAuthorResolver(): AuthorResolver {
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  const [me, setMe] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    let live = true;
    api.listAgents()
      .then(({ agents }) => { if (live) setAgentNames(Object.fromEntries(agents.map(a => [a.id, a.name]))); })
      .catch(() => {});
    api.getMe()
      .then(u => { if (live) setMe({ id: u.id, label: u.username ?? u.name ?? u.email }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  return (authorKind, authorId) => {
    if (authorKind === "agent") {
      const name = agentNames[authorId];
      return name ? `@${name}` : "agent";
    }
    if (me && me.id === authorId) return `@${me.label}`;
    return "reviewer";
  };
}

interface Props {
  ns: string;
  repo: string;
  changeId: string;
  threads: CommentThread[];
  onChanged: () => void;
  // When set (e.g. from clicking a diff line), pre-fills the new-thread form and
  // scrolls to it so the reviewer doesn't have to type the path + line by hand.
  prefill?: { path: string; line: number } | null;
}

export function CommentThreads({ ns, repo, changeId, threads, onChanged, prefill }: Props) {
  const [newPath, setNewPath] = useState("");
  const [newLine, setNewLine] = useState("");
  const [newBody, setNewBody] = useState("");
  const [busy, setBusy] = useState(false);
  // Slash-command dispatch result from the last POST (v3 P4) — shown inline.
  const [dispatch, setDispatch] = useState<WorkflowDispatch | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const resolveAuthor = useAuthorResolver();

  useEffect(() => {
    if (!prefill) return;
    setNewPath(prefill.path);
    setNewLine(String(prefill.line));
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    bodyRef.current?.focus();
  }, [prefill]);

  // A slash-command comment (/verify, /review, …) isn't ABOUT a line — anchor
  // it to a synthetic "discussion:0" thread so the server (which requires a
  // path + line for a new thread) accepts it without the user inventing one.
  const slashDraft = isSlashCommandDraft(newBody);

  async function addNewThread() {
    if (!newBody.trim() || (!slashDraft && (!newPath || !newLine))) return;
    setBusy(true);
    setDispatch(null);
    try {
      const res = await api.addComment(ns, repo, changeId, {
        path: newPath || "discussion",
        line: newLine ? Number(newLine) : 0,
        side: "new",
        body: newBody,
      });
      setDispatch(res.workflowRun ?? null);
      setNewPath(""); setNewLine(""); setNewBody("");
      onChanged();
    } finally { setBusy(false); }
  }

  async function reply(threadId: string, body: string) {
    if (!body.trim()) return;
    await api.addComment(ns, repo, changeId, { threadId, body });
    onChanged();
  }

  async function toggleResolved(t: CommentThread) {
    if (t.resolved) await api.unresolveThread(ns, repo, changeId, t.id);
    else await api.resolveThread(ns, repo, changeId, t.id);
    onChanged();
  }

  return (
    <div className="space-y-4">
      {threads.length === 0 && <div className="text-sm text-muted-foreground">No comments yet. Start a thread on a specific file + line below.</div>}
      {threads.map(t => (
        <Thread key={t.id} thread={t} onReply={body => reply(t.id, body)} onToggleResolved={() => toggleResolved(t)} resolveAuthor={resolveAuthor} />
      ))}

      <div ref={formRef} className="pt-3 border-t border-border space-y-2 scroll-mt-4">
        <div className="text-xs font-mono text-muted-foreground">Start new thread</div>
        <p className="text-xs text-muted-foreground">Click a line number in the Focused or Full diff to anchor a comment here automatically, or fill in the file + line below. Start with <code className="font-mono">/</code> to dispatch a workflow.</p>
        <div className="flex gap-2">
          <Input placeholder="path/to/file.ts" value={newPath} onChange={e => setNewPath(e.target.value)} className="flex-1" />
          <Input placeholder="line" type="number" value={newLine} onChange={e => setNewLine(e.target.value)} className="w-24" />
        </div>
        <Textarea ref={bodyRef} placeholder="Leave a comment. Use @name to mention an agent or user, or start with / to dispatch a workflow." value={newBody} onChange={e => setNewBody(e.target.value)} rows={3} />
        <SlashCommandHint draft={newBody} />
        <Button disabled={busy || !newBody.trim() || (!slashDraft && (!newPath || !newLine))} onClick={addNewThread} size="sm">Post</Button>
        {dispatch && <WorkflowDispatchNotice result={dispatch} runsHref="/agents/runs" />}
      </div>
    </div>
  );
}

export function Thread({ thread, onReply, onToggleResolved, resolveAuthor }: { thread: CommentThread; onReply: (body: string) => Promise<void>; onToggleResolved: () => Promise<void>; resolveAuthor?: AuthorResolver }) {
  const [replyBody, setReplyBody] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden">
      <div className="px-3 py-2 bg-muted/40 flex items-center justify-between text-xs font-mono">
        <span>{thread.path}:{thread.line}</span>
        <div className="flex items-center gap-2">
          {thread.resolved && <Badge variant="secondary">Resolved</Badge>}
          <button className="text-muted-foreground hover:text-foreground" onClick={() => void onToggleResolved()}>
            {thread.resolved ? "Unresolve" : "Resolve"}
          </button>
        </div>
      </div>
      <div className="p-3 space-y-2">
        {thread.comments.map(c => {
          // Prefer a resolved name/@handle; fall back to the bare kind (never a
          // raw UUID slice) when the resolver can't name this author.
          const author = resolveAuthor ? resolveAuthor(c.authorKind, c.authorId) : c.authorKind;
          return (
          <div key={c.id} className="text-sm">
            <div className="text-xs text-muted-foreground">
              <span className="text-foreground">{author}</span> · {new Date(c.createdAt).toLocaleString()}
            </div>
            <div className="whitespace-pre-wrap">{c.body}</div>
            {c.suggestion && <pre className="mt-1 text-xs bg-muted/40 p-2 rounded border border-border">{c.suggestion}</pre>}
          </div>
          );
        })}
        {!thread.resolved && (
          <div className="space-y-2 pt-2 border-t border-border">
            <Textarea value={replyBody} onChange={e => setReplyBody(e.target.value)} rows={2} placeholder="Reply…" />
            <Button size="sm" disabled={busy || !replyBody.trim()} onClick={async () => { setBusy(true); try { await onReply(replyBody); setReplyBody(""); } finally { setBusy(false); } }}>
              Reply
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
