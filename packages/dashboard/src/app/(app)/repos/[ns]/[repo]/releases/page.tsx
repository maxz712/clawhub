"use client";

import { use, useEffect, useState } from "react";
import { api, type Release, type Repo } from "@/lib/api";
import { RepoHeader } from "@/components/repo-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Rocket } from "lucide-react";

export default function ReleasesPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [data, setData] = useState<Repo | null>(null);
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState("");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadReleases() {
    api.listReleases(ns, repo).then(r => setReleases(r.releases)).catch(() => setReleases([]));
  }
  useEffect(() => {
    api.getRepo(ns, repo).then(r => setData(r.repo)).catch(() => {});
    loadReleases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ns, repo]);

  async function draft() {
    if (!tag.trim()) return;
    setPending(true); setError(null);
    try {
      // changeId is optional on the route — cut the release straight off the
      // default branch HEAD when none is supplied.
      await api.createRelease(ns, repo, { tag: tag.trim(), title: title.trim() || undefined, body: notes.trim() || undefined, changeId: "" });
      setTag(""); setTitle(""); setNotes(""); setOpen(false);
      loadReleases();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <RepoHeader ns={ns} repo={repo} data={data} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Releases</h1>
          <p className="text-sm text-muted-foreground">Tag a point on the default branch with notes.</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => setOpen(true)}><Rocket className="h-4 w-4" /> Draft a release</Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Draft a release</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Tag</Label><Input value={tag} onChange={e => setTag(e.target.value)} placeholder="v1.0.0" autoFocus /></div>
              <div><Label>Title</Label><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Optional — defaults to the tag" /></div>
              <div><Label>Notes</Label><Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={5} placeholder="What changed in this release" /></div>
              {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={draft} disabled={pending || !tag.trim()}>Create release</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <div className="space-y-2">
        {releases === null && <div className="text-muted-foreground text-sm">Loading…</div>}
        {releases?.length === 0 && <div className="text-muted-foreground text-sm">No releases yet. Click &ldquo;Draft a release&rdquo; to tag the default branch, or your agents can create them via the API after a Change merges.</div>}
        {releases?.map(r => (
          <div key={r.id} className="p-4 rounded-lg border bg-card">
            <div className="flex items-center gap-2">
              <code className="font-mono font-semibold text-primary">{r.tag}</code>
              {r.title && <span className="text-sm">{r.title}</span>}
              <span className="ml-auto text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            {r.body && <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">{r.body}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
