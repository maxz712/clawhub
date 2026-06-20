"use client";

import { useEffect, useState, use } from "react";
import { api, type Issue, type IssueComment, type IssueChangeLink } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { Pencil, GitPullRequest, X } from "lucide-react";

export default function IssueDetailPage({ params }: { params: Promise<{ ns: string; repo: string; num: string }> }) {
  const { ns, repo, num } = use(params);
  const numN = Number(num);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [links, setLinks] = useState<IssueChangeLink[]>([]);
  const [linkRef, setLinkRef] = useState("");
  const [linking, setLinking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Edit mode (#10).
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const r = await api.getIssue(ns, repo, numN);
    setIssue(r.issue);
    setComments(r.comments);
    setLinks(r.links ?? []);
    setLoaded(true);
  }
  async function linkChange() {
    const ref = linkRef.trim();
    if (!ref) return;
    setLinking(true); setError(null);
    // Accept a branch name or a change UUID.
    const body = /^[0-9a-f-]{36}$/i.test(ref) ? { changeId: ref } : { branch: ref };
    try { await api.linkIssueChange(ns, repo, numN, body); setLinkRef(""); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setLinking(false); }
  }
  async function unlinkChange(changeId: string) {
    setError(null);
    try { await api.unlinkIssueChange(ns, repo, numN, changeId); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { load().catch(e => { setError((e as Error).message); setLoaded(true); }); /* eslint-disable-next-line */ }, [ns, repo, numN]);

  function startEdit() {
    if (!issue) return;
    setEditTitle(issue.title); setEditBody(issue.body ?? ""); setEditing(true);
  }
  async function saveEdit() {
    if (!editTitle.trim()) return;
    setSaving(true); setError(null);
    try { await api.patchIssue(ns, repo, numN, { title: editTitle.trim(), body: editBody }); setEditing(false); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  async function toggle() {
    if (!issue) return;
    await api.patchIssue(ns, repo, numN, { status: issue.status === "open" ? "closed" : "open" });
    await load();
  }
  async function postComment() {
    if (!comment.trim()) return;
    setPosting(true);
    try { await api.addIssueComment(ns, repo, numN, comment); setComment(""); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setPosting(false); }
  }

  if (error && !issue) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!loaded) return <div className="text-muted-foreground">Loading…</div>;
  if (!issue) return <div className="text-muted-foreground">Issue #{numN} not found.</div>;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-2">
          <code className="font-mono text-muted-foreground">#{issue.number}</code>
          <Badge variant={issue.status === "open" ? "default" : "secondary"} className="text-[10px] uppercase">{issue.status}</Badge>
        </div>
        {editing ? (
          <Input value={editTitle} onChange={e => setEditTitle(e.target.value)} className="mt-1 text-lg font-bold" />
        ) : (
          <div className="flex items-start justify-between gap-3 mt-1">
            <h1 className="text-2xl font-bold tracking-tight">{issue.title}</h1>
            <Button variant="ghost" size="sm" className="gap-1.5 shrink-0" onClick={startEdit}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
          </div>
        )}
      </header>

      {editing ? (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <div>
              <Textarea value={editBody} onChange={e => setEditBody(e.target.value)} rows={8}
                placeholder="Describe the issue. Markdown supported — including ![alt](image-url) for screenshots." className="font-mono text-sm" />
              <p className="text-xs text-muted-foreground mt-1">Markdown + GFM supported. Paste an image URL as <code className="font-mono">![](https://…png)</code> for a screenshot.</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={saveEdit} disabled={saving || !editTitle.trim()}>{saving ? "Saving…" : "Save"}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      ) : issue.body ? (
        <Card><CardContent className="pt-6"><Markdown>{issue.body}</Markdown></CardContent></Card>
      ) : (
        <p className="text-sm text-muted-foreground italic">No description.</p>
      )}

      {/* Linked changes (#13) — N:M "this PR fixes this issue". */}
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><GitPullRequest className="h-4 w-4" /> Linked changes</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {links.length === 0 ? (
            <p className="text-xs text-muted-foreground">No changes linked yet.</p>
          ) : (
            links.map(l => (
              <div key={l.id} className="flex items-center justify-between gap-2 rounded border border-border px-2.5 py-1.5">
                <a href={`/repos/${ns}/${repo}/changes/${l.id}`} className="min-w-0 flex items-center gap-2">
                  <code className="font-mono text-xs text-primary truncate">{l.branch}</code>
                  <Badge variant="secondary" className="text-[10px] uppercase shrink-0">{l.status}</Badge>
                  {l.intent && <span className="text-xs text-muted-foreground truncate hidden sm:inline">{l.intent}</span>}
                </a>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" title="Unlink" onClick={() => unlinkChange(l.id)}><X className="h-3.5 w-3.5" /></Button>
              </div>
            ))
          )}
          <div className="flex gap-2 pt-1">
            <Input value={linkRef} onChange={e => setLinkRef(e.target.value)} placeholder="Link a change by branch name or ID"
              onKeyDown={e => { if (e.key === "Enter") linkChange(); }} className="h-8 text-sm" />
            <Button size="sm" variant="outline" onClick={linkChange} disabled={!linkRef.trim() || linking}>{linking ? "…" : "Link"}</Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight text-muted-foreground">
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </h2>
        {comments.length === 0 ? (
          <div className="text-sm text-muted-foreground">No comments yet.</div>
        ) : (
          comments.map(c => (
            <Card key={c.id}>
              <CardContent className="pt-4 space-y-1">
                <div className="text-xs font-mono text-muted-foreground">
                  {c.authorKind} · {new Date(c.createdAt).toLocaleString()}
                </div>
                <Markdown>{c.body}</Markdown>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={toggle}>{issue.status === "open" ? "Close issue" : "Reopen issue"}</Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Add a comment</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <Textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Leave a comment. Markdown supported. Use @name to mention an agent or user." />
          <Button size="sm" onClick={postComment} disabled={!comment.trim() || posting}>{posting ? "Posting…" : "Post comment"}</Button>
        </CardContent>
      </Card>
    </div>
  );
}
