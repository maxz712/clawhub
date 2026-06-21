"use client";

import { use, useCallback, useEffect, useState } from "react";
import { api, type AuditEvent, type Repo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RepoHeader } from "@/components/repo-header";

const PAGE_SIZE = 100;

const CATEGORIES = ["all", "auth", "repo", "change", "review", "merge", "issue", "agent", "secret", "ci", "release", "webhook", "policy", "admin", "other"];

// Render the most useful metadata keys as readable chips; the full payload is
// available on expand rather than a single truncated JSON.stringify blob.
function MetadataCell({ metadata }: { metadata: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(metadata ?? {});
  if (entries.length === 0) return <span className="text-muted-foreground/50">—</span>;
  const fmt = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1">
        {entries.slice(0, open ? entries.length : 3).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] max-w-[200px] truncate">
            <span className="text-muted-foreground">{k}</span>
            <span className="text-foreground truncate">{fmt(v)}</span>
          </span>
        ))}
        {entries.length > 3 && (
          <button onClick={() => setOpen(o => !o)} className="text-[10px] text-muted-foreground hover:text-foreground underline">
            {open ? "less" : `+${entries.length - 3} more`}
          </button>
        )}
      </div>
    </div>
  );
}

export default function AuditPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [data, setData] = useState<Repo | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState("all");
  const [error, setError] = useState<string | null>(null);
  // A full page back means there may be more — the API returns up to PAGE_SIZE
  // newest-first, so fewer than a page == we've reached the end.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    api.getRepo(ns, repo).then(r => setData(r.repo)).catch(() => {});
  }, [ns, repo]);

  useEffect(() => {
    setEvents(null); setError(null); setHasMore(false);
    api.listAudit(ns, repo, { limit: PAGE_SIZE, ...(category === "all" ? {} : { category }) })
      .then(r => { setEvents(r.events); setTotal(r.total); setHasMore(r.events.length >= PAGE_SIZE); })
      .catch(e => { setEvents([]); setError((e as Error).message); });
  }, [ns, repo, category]);

  // Page back with the `before` cursor — the audit API keys it on the oldest
  // loaded event's createdAt and returns the next-older page (newest-first).
  const loadMore = useCallback(async () => {
    if (!events || events.length === 0) return;
    setLoadingMore(true); setError(null);
    try {
      const before = events[events.length - 1].createdAt;
      const r = await api.listAudit(ns, repo, { limit: PAGE_SIZE, before, ...(category === "all" ? {} : { category }) });
      setEvents(prev => [...(prev ?? []), ...r.events]);
      setHasMore(r.events.length >= PAGE_SIZE);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [ns, repo, category, events]);

  return (
    <div className="space-y-4">
      <RepoHeader ns={ns} repo={repo} data={data} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Audit log</h1>
          {/* `total` is repo-wide (the API counts all events for the repo, not
              the active category filter) — label it so the number is honest. */}
          <p className="text-sm text-muted-foreground">Every action on {ns}/{repo}.{events !== null && !error && ` ${total} total events repo-wide.`}</p>
        </div>
        <Select value={category} onValueChange={v => setCategory(v ?? "all")}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>Couldn&apos;t load the audit log: {error}</AlertDescription></Alert>}

      <Card>
        <CardHeader><CardTitle className="text-sm">Recent</CardTitle></CardHeader>
        <CardContent>
          <div className="divide-y divide-border font-mono text-xs">
            {events === null && !error && <div className="text-muted-foreground py-4">Loading…</div>}
            {events?.length === 0 && !error && <div className="text-muted-foreground py-4">No events yet. Actions on this repo — pushes, reviews, merges, secret changes — show up here.</div>}
            {(events ?? []).map(e => {
              // Prefer the resolved actor name (e.g. "@security-reviewer" or a
              // human handle); fall back to the bare kind only when null. Read
              // defensively — the field may briefly be absent on the API row.
              const actorName = (e as AuditEvent & { actorName?: string | null }).actorName ?? null;
              return (
              <div key={e.id} className="grid grid-cols-[auto_auto_auto_1fr_auto] items-start gap-3 py-2">
                <Badge variant="outline">{e.category}</Badge>
                <span>{e.action}</span>
                {actorName ? (
                  <span title={e.actorKind}>{actorName}</span>
                ) : (
                  <span className="text-muted-foreground">{e.actorKind}</span>
                )}
                <MetadataCell metadata={e.metadata} />
                <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
              </div>
              );
            })}
          </div>
          {hasMore && (
            <div className="pt-3 flex justify-center">
              <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
