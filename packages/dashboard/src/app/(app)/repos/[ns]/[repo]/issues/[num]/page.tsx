"use client";

import { useEffect, useState, use } from "react";
import { api, type Issue } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export default function IssueDetailPage({ params }: { params: Promise<{ ns: string; repo: string; num: string }> }) {
  const { ns, repo, num } = use(params);
  const numN = Number(num);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { issues } = await api.listIssues(ns, repo);
    setIssue(issues.find(i => i.number === numN) ?? null);
  }
  useEffect(() => { load().catch(e => setError((e as Error).message)); /* eslint-disable-next-line */ }, [ns, repo, numN]);

  async function toggle() {
    if (!issue) return;
    await api.patchIssue(ns, repo, numN, { status: issue.status === "open" ? "closed" : "open" });
    await load();
  }
  async function postComment() {
    if (!comment) return;
    await api.addIssueComment(ns, repo, numN, comment);
    setComment("");
  }

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!issue) return <div className="text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-2">
          <code className="font-mono text-muted-foreground">#{issue.number}</code>
          <Badge variant={issue.status === "open" ? "default" : "secondary"} className="text-[10px] uppercase">{issue.status}</Badge>
        </div>
        <h1 className="text-2xl font-bold mt-1">{issue.title}</h1>
      </header>
      {issue.body && (
        <Card><CardContent className="prose prose-invert text-sm pt-6"><p>{issue.body}</p></CardContent></Card>
      )}
      <div className="flex gap-2">
        <Button variant="outline" onClick={toggle}>{issue.status === "open" ? "Close issue" : "Reopen issue"}</Button>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">Add a comment</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} />
          <Button size="sm" onClick={postComment} disabled={!comment}>Post comment</Button>
        </CardContent>
      </Card>
    </div>
  );
}
