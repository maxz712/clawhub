"use client";

import { useEffect, useState, use } from "react";
import { api, type Issue, type IssueComment } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export default function IssueDetailPage({ params }: { params: Promise<{ ns: string; repo: string; num: string }> }) {
  const { ns, repo, num } = use(params);
  const numN = Number(num);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    // Fetch the single issue directly (issue + comments come back together).
    const r = await api.getIssue(ns, repo, numN);
    setIssue(r.issue);
    setComments(r.comments);
    setLoaded(true);
  }
  useEffect(() => { load().catch(e => { setError((e as Error).message); setLoaded(true); }); /* eslint-disable-next-line */ }, [ns, repo, numN]);

  async function toggle() {
    if (!issue) return;
    await api.patchIssue(ns, repo, numN, { status: issue.status === "open" ? "closed" : "open" });
    await load();
  }
  async function postComment() {
    if (!comment.trim()) return;
    setPosting(true);
    try {
      await api.addIssueComment(ns, repo, numN, comment);
      setComment("");
      await load();
    } catch (e) { setError((e as Error).message); }
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
        <h1 className="text-2xl font-bold tracking-tight mt-1">{issue.title}</h1>
      </header>
      {issue.body && (
        <Card><CardContent className="prose prose-invert text-sm pt-6"><p className="whitespace-pre-wrap">{issue.body}</p></CardContent></Card>
      )}

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
                <div className="text-sm whitespace-pre-wrap">{c.body}</div>
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
          <Textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Leave a comment. Use @name to mention an agent or user." />
          <Button size="sm" onClick={postComment} disabled={!comment.trim() || posting}>{posting ? "Posting…" : "Post comment"}</Button>
        </CardContent>
      </Card>
    </div>
  );
}
