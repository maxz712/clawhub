"use client";

import { useEffect, useRef, useState } from "react";
import { api, type CommentThread } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

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
  const formRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!prefill) return;
    setNewPath(prefill.path);
    setNewLine(String(prefill.line));
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    bodyRef.current?.focus();
  }, [prefill]);

  async function addNewThread() {
    if (!newPath || !newLine || !newBody.trim()) return;
    setBusy(true);
    try {
      await api.addComment(ns, repo, changeId, {
        path: newPath,
        line: Number(newLine),
        side: "new",
        body: newBody,
      });
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
        <Thread key={t.id} thread={t} onReply={body => reply(t.id, body)} onToggleResolved={() => toggleResolved(t)} />
      ))}

      <div ref={formRef} className="pt-3 border-t border-border space-y-2 scroll-mt-4">
        <div className="text-xs font-mono text-muted-foreground">Start new thread</div>
        <p className="text-xs text-muted-foreground">Click a line number in the Focused or Full diff to anchor a comment here automatically, or fill in the file + line below.</p>
        <div className="flex gap-2">
          <Input placeholder="path/to/file.ts" value={newPath} onChange={e => setNewPath(e.target.value)} className="flex-1" />
          <Input placeholder="line" type="number" value={newLine} onChange={e => setNewLine(e.target.value)} className="w-24" />
        </div>
        <Textarea ref={bodyRef} placeholder="Leave a comment. Use @name to mention an agent or user." value={newBody} onChange={e => setNewBody(e.target.value)} rows={3} />
        <Button disabled={busy || !newPath || !newLine || !newBody.trim()} onClick={addNewThread} size="sm">Post</Button>
      </div>
    </div>
  );
}

function Thread({ thread, onReply, onToggleResolved }: { thread: CommentThread; onReply: (body: string) => Promise<void>; onToggleResolved: () => Promise<void> }) {
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
        {thread.comments.map(c => (
          <div key={c.id} className="text-sm">
            <div className="text-xs font-mono text-muted-foreground">{c.authorKind} · {new Date(c.createdAt).toLocaleString()}</div>
            <div className="whitespace-pre-wrap">{c.body}</div>
            {c.suggestion && <pre className="mt-1 text-xs bg-muted/40 p-2 rounded border border-border">{c.suggestion}</pre>}
          </div>
        ))}
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
