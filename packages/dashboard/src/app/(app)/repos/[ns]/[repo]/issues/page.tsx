"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, type Issue, type IssueStatus, type IssuePriority, type Milestone } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, User } from "lucide-react";

const PRIORITIES: IssuePriority[] = ["low", "normal", "high", "urgent"];
// Sentinel for the "No milestone" option — Base UI select values are strings.
const NO_MILESTONE = "none";

// Small priority badge — muted for low/normal, accented for high/urgent.
function PriorityBadge({ priority, className }: { priority: IssuePriority; className?: string }) {
  const variant = priority === "urgent" ? "destructive" : priority === "high" ? "default" : "outline";
  return <Badge variant={variant} className={`text-[10px] uppercase ${className ?? ""}`}>{priority}</Badge>;
}

export default function IssuesPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [status, setStatus] = useState<IssueStatus>("open");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [milestoneId, setMilestoneId] = useState<string>(NO_MILESTONE);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  // Resolve assignee agent ids → names so rows never show a raw UUID.
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  // Render create failures INSIDE the dialog (above the footer) so they aren't
  // hidden behind it; keep the dialog open on failure (#2).
  const [createError, setCreateError] = useState<string | null>(null);

  async function load() {
    const r = await api.listIssues(ns, repo, { status });
    setIssues(r.issues);
  }
  useEffect(() => { load().catch(e => setError((e as Error).message)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ns, repo, status]);
  // Milestones for the create dialog selector (independent of the status filter).
  useEffect(() => { api.listMilestones(ns, repo).then(r => setMilestones(r.milestones)).catch(() => {}); }, [ns, repo]);
  // Build an agent id→name map for assignee resolution (never crash on failure).
  useEffect(() => {
    api.listAgents().then(r => {
      const m: Record<string, string> = {};
      for (const a of r.agents) m[a.id] = a.name;
      setAgentNames(m);
    }).catch(() => {});
  }, []);

  // Human-readable assignee label: @name, falling back to a short id.
  const assigneeLabel = (id: string | null | undefined) => id ? `@${agentNames[id] ?? id.slice(0, 8)}` : null;

  // Quick lookup so list rows can show a milestone's title from its id.
  const milestoneTitle = (id: string | null | undefined) => id ? (milestones.find(m => m.id === id)?.title ?? null) : null;

  async function create() {
    if (!title) return;
    setPending(true); setCreateError(null);
    try {
      const labelList = labels.split(",").map(s => s.trim()).filter(Boolean);
      await api.createIssue(ns, repo, {
        title,
        body: body || undefined,
        labels: labelList.length ? labelList : undefined,
        priority,
        milestoneId: milestoneId === NO_MILESTONE ? null : milestoneId,
      });
      setTitle(""); setBody(""); setLabels(""); setPriority("normal"); setMilestoneId(NO_MILESTONE); setOpen(false);
      await load();
    } catch (e) { setCreateError((e as Error).message); }
    finally { setPending(false); }
  }

  // Distinct labels across the loaded issue set (no label-list endpoint), for a
  // client-side label filter.
  const allLabels = Array.from(new Set((issues ?? []).flatMap(i => i.labels))).sort();
  const visibleIssues = (issues ?? []).filter(i => !labelFilter || i.labels.includes(labelFilter));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Issues</h1>
        <Button size="sm" className="gap-2" onClick={() => { setCreateError(null); setOpen(true); }}><Plus className="h-4 w-4" /> New issue</Button>
        <Dialog open={open} onOpenChange={o => { if (o) setCreateError(null); setOpen(o); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>New issue</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Title</Label><Input value={title} onChange={e => setTitle(e.target.value)} autoFocus /></div>
              <div><Label>Body</Label><Textarea value={body} onChange={e => setBody(e.target.value)} rows={5} /></div>
              <div><Label>Labels (comma-separated)</Label><Input value={labels} onChange={e => setLabels(e.target.value)} placeholder="bug, p1" /></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Priority</Label>
                  <Select value={priority} onValueChange={v => setPriority((v as IssuePriority) ?? "normal")}>
                    <SelectTrigger className="w-full mt-1 capitalize"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PRIORITIES.map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Milestone</Label>
                  <Select value={milestoneId} onValueChange={v => setMilestoneId(v ?? NO_MILESTONE)}>
                    <SelectTrigger className="w-full mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_MILESTONE}>No milestone</SelectItem>
                      {milestones.map(m => <SelectItem key={m.id} value={m.id}>{m.title}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            {createError && <Alert variant="destructive" className="mt-3"><AlertDescription>{createError}</AlertDescription></Alert>}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={create} disabled={pending || !title}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <p className="text-sm text-muted-foreground">
        Issues are a task queue for your agents. An agent pulls its work with{" "}
        <code className="font-mono text-xs">?assigned=me</code> (using its agent token), and a commit
        with <code className="font-mono text-xs">Closes: #N</code> auto-closes the issue when the
        change merges.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {(["open", "closed"] as IssueStatus[]).map(s => (
          <Button key={s} size="sm" variant={status === s ? "secondary" : "ghost"} className="h-9 sm:h-7 capitalize" onClick={() => setStatus(s)}>{s}</Button>
        ))}
        {allLabels.length > 0 && (
          <>
            <span className="text-border">·</span>
            <Button size="sm" variant={labelFilter === null ? "secondary" : "ghost"} className="h-9 sm:h-7" onClick={() => setLabelFilter(null)}>All labels</Button>
            {allLabels.map(l => (
              <Button key={l} size="sm" variant={labelFilter === l ? "secondary" : "ghost"} className="h-9 sm:h-7" onClick={() => setLabelFilter(labelFilter === l ? null : l)}>{l}</Button>
            ))}
          </>
        )}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!issues ? <div className="text-muted-foreground">Loading…</div>
        : visibleIssues.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center space-y-3">
              <p className="text-sm text-muted-foreground">
                No {status} issues{labelFilter ? ` labeled "${labelFilter}"` : ""}.
              </p>
              <p className="text-sm text-muted-foreground max-w-prose mx-auto">
                Issues are your agent&apos;s task queue. File the work here; your agent pulls open
                issues assigned to it (<code className="font-mono text-xs">?assigned=me</code>), pushes a
                change with <code className="font-mono text-xs">Closes: #N</code> in the commit, and the
                issue auto-closes on merge.
              </p>
              <Button size="sm" className="gap-2" onClick={() => { setCreateError(null); setOpen(true); }}><Plus className="h-4 w-4" /> New issue</Button>
            </CardContent>
          </Card>
        )
        : <ul className="space-y-2">{visibleIssues.map(i => (
            <li key={i.id}>
              <Link href={`/repos/${ns}/${repo}/issues/${i.number}`} className="block">
                <Card className="py-0 hover:bg-accent transition-colors">
                  <CardContent className="flex items-center gap-3 p-3">
                    <code className="text-sm font-mono text-muted-foreground w-14">#{i.number}</code>
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{i.title}</div>
                      {(i.labels.length > 0 || (i.priority && i.priority !== "normal") || milestoneTitle(i.milestoneId)) && (
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                          {i.priority && i.priority !== "normal" && <PriorityBadge priority={i.priority} />}
                          {milestoneTitle(i.milestoneId) && (
                            <Badge variant="secondary" className="text-[10px]">{milestoneTitle(i.milestoneId)}</Badge>
                          )}
                          {i.labels.map(l => <Badge key={l} variant="outline" className="text-[10px]">{l}</Badge>)}
                        </div>
                      )}
                    </div>
                    <span className="hidden sm:flex items-center gap-1 text-[10px] text-muted-foreground shrink-0" title="Assignee — the agent that pulls this via ?assigned=me">
                      <User className="h-3 w-3" />
                      {assigneeLabel(i.assignedAgentId) ? <span className="max-w-[10rem] truncate">{assigneeLabel(i.assignedAgentId)}</span> : <span>unassigned</span>}
                    </span>
                    <Badge variant={i.status === "open" ? "default" : "secondary"} className="text-[10px] uppercase shrink-0">{i.status}</Badge>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}</ul>}
    </div>
  );
}
