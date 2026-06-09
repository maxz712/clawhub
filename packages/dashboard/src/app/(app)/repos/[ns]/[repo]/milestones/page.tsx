"use client";

import { use, useEffect, useState } from "react";
import { api, type Milestone } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function MilestonesPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [rows, setRows] = useState<Milestone[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");

  async function load() { const r = await api.listMilestones(ns, repo); setRows(r.milestones); }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ns, repo]);

  async function create() {
    if (!title.trim()) return;
    await api.createMilestone(ns, repo, { title, description, dueDate: dueDate || undefined });
    setTitle(""); setDescription(""); setDueDate("");
    void load();
  }
  async function toggle(m: Milestone) {
    await api.patchMilestone(ns, repo, m.id, { status: m.status === "open" ? "closed" : "open" });
    void load();
  }
  async function remove(m: Milestone) {
    await api.deleteMilestone(ns, repo, m.id);
    void load();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Milestones</h1>
        <p className="text-sm text-muted-foreground">Group issues around a deliverable.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">New milestone</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div><Label>Title</Label><Input value={title} onChange={e => setTitle(e.target.value)} /></div>
          <div><Label>Description</Label><Textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} /></div>
          <div><Label>Due date</Label><Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></div>
          <Button onClick={create}>Create</Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {rows.map(m => (
          <Card key={m.id}>
            <CardContent className="pt-4 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{m.title}</span>
                  <Badge variant={m.status === "open" ? "default" : "secondary"}>{m.status}</Badge>
                </div>
                {m.description && <div className="text-sm text-muted-foreground mt-1">{m.description}</div>}
                {m.dueDate && <div className="text-xs text-muted-foreground mt-1">Due {new Date(m.dueDate).toLocaleDateString()}</div>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void toggle(m)}>{m.status === "open" ? "Close" : "Reopen"}</Button>
                <Button size="sm" variant="outline" onClick={() => void remove(m)}>Delete</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
