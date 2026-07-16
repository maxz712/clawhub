"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type Notification, type NotificationPrefs, type Mention, type Repo } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AtSign, GitPullRequest, GitMerge, Undo2, AlertTriangle, Bell } from "lucide-react";

const KIND: Record<string, { label: string; icon: typeof Bell }> = {
  mention: { label: "Mention", icon: AtSign },
  review_requested: { label: "Review requested", icon: GitPullRequest },
  change_merged: { label: "Change merged", icon: GitMerge },
  change_rolled_back: { label: "Change rolled back", icon: Undo2 },
  ci_failure: { label: "CI failed", icon: AlertTriangle },
};

export default function NotificationsPage() {
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground">What happened to you — review requests, change/CI updates, and @-mentions — plus your email settings.</p>
      </div>
      <Tabs defaultValue="inbox">
        <TabsList variant="line">
          <TabsTrigger value="inbox">Inbox</TabsTrigger>
          <TabsTrigger value="mentions">Mentions</TabsTrigger>
          <TabsTrigger value="settings">Email settings</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox" className="pt-4"><Inbox /></TabsContent>
        <TabsContent value="mentions" className="pt-4"><MentionsTab /></TabsContent>
        <TabsContent value="settings" className="pt-4"><EmailSettings /></TabsContent>
      </Tabs>
    </div>
  );
}

function Inbox() {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setItems((await api.listNotifications()).notifications); }
    catch (e) { setError((e as Error).message || "Couldn't load your inbox."); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Tell the sidebar Bell to re-fetch its unread count immediately — otherwise
  // marking read while staying on /notifications leaves the badge stale until
  // the sidebar's 60s poll.
  function signalChanged() {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("clawhub:notifications-changed"));
  }
  async function markRead(id: string) {
    setItems(prev => prev?.map(n => n.id === id ? { ...n, read: true } : n) ?? null);
    try { await api.markNotificationsRead([id]); signalChanged(); } catch { void load(); }
  }
  async function markAll() {
    setItems(prev => prev?.map(n => ({ ...n, read: true })) ?? null);
    try { await api.markAllNotificationsRead(); signalChanged(); } catch { void load(); }
  }

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (items === null) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const unread = items.filter(n => !n.read).length;

  if (items.length === 0) {
    return (
      <Card className="py-0">
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          <Bell className="h-6 w-6 mx-auto mb-2 opacity-50" />
          You&apos;re all caught up. Review requests and @-mentions land here.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{unread > 0 ? `${unread} unread` : "All read"}</div>
        {unread > 0 && <Button size="sm" variant="outline" onClick={() => void markAll()}>Mark all read</Button>}
      </div>
      <div className="space-y-2">
        {items.map(n => {
          const meta = KIND[n.kind] ?? { label: n.kind, icon: Bell };
          const Icon = meta.icon;
          // The content (title/body/meta) is the clickable link; the "Mark read"
          // button is a SIBLING of the link, never a descendant — nesting a
          // <button> inside an <a> is invalid HTML + a hydration warning.
          const content = (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-[10px]">{meta.label}</Badge>
                <span className="text-xs text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</span>
              </div>
              <div className="text-sm font-medium mt-1">{n.title}</div>
              {n.body && <div className="text-sm text-muted-foreground truncate">{n.body}</div>}
            </>
          );
          return (
            <Card key={n.id} className={`py-0 ${n.read ? "opacity-70" : "ring-primary/40"}`}>
              <CardContent className="flex items-start gap-3 p-3">
                {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread" />}
                <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${n.read ? "text-muted-foreground" : "text-primary"}`} />
                {n.link ? (
                  <Link href={n.link} onClick={() => { if (!n.read) void markRead(n.id); }} className="min-w-0 flex-1 block">{content}</Link>
                ) : (
                  <div className="min-w-0 flex-1">{content}</div>
                )}
                {!n.read && (
                  <button onClick={() => void markRead(n.id)} className="text-xs text-muted-foreground hover:text-foreground shrink-0">
                    Mark read
                  </button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function EmailSettings() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void api.getNotificationPrefs().then(r => setPrefs(r.prefs)); }, []);

  async function update(patch: Partial<NotificationPrefs>) {
    if (!prefs) return;
    const prev = prefs;
    setPrefs({ ...prefs, ...patch });
    setSaving(true); setSaved(false); setError(null);
    try {
      const r = await api.updateNotificationPrefs(patch);
      setPrefs(r.prefs); setSaved(true);
    } catch (e) {
      setPrefs(prev);
      setError((e as Error).message || "Failed to save email settings.");
    } finally { setSaving(false); }
  }

  if (!prefs) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4 max-w-xl">
      <p className="text-sm text-muted-foreground">Control when ClawHub emails you. In-app notifications above are always delivered.</p>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <Card>
        <CardHeader><CardTitle className="text-sm">Email settings</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Toggle label="Enable email notifications" checked={prefs.email} onChange={v => update({ email: v })} />
          <Toggle label="When I'm @-mentioned" checked={prefs.emailOnMention} onChange={v => update({ emailOnMention: v })} disabled={!prefs.email} />
          <Toggle label="When my review is requested" checked={prefs.emailOnReviewRequested} onChange={v => update({ emailOnReviewRequested: v })} disabled={!prefs.email} />
          <Toggle label="When a change is merged in a watched repo" checked={prefs.emailOnChangeMerged} onChange={v => update({ emailOnChangeMerged: v })} disabled={!prefs.email} />
          <Toggle label="When a merged change of mine is rolled back" checked={prefs.emailOnChangeRolledBack} onChange={v => update({ emailOnChangeRolledBack: v })} disabled={!prefs.email} />
          <Toggle label="When CI fails on my change" checked={prefs.emailOnCiFailure} onChange={v => update({ emailOnCiFailure: v })} disabled={!prefs.email} />
          <div className="pt-2">
            <Label>Digest</Label>
            <Select value={prefs.digestFrequency} onValueChange={v => update({ digestFrequency: v ?? "never" })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Never</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
      {saving ? <div className="text-xs text-muted-foreground">Saving…</div> : saved && <div className="text-xs text-primary">Saved.</div>}
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center justify-between gap-3 text-sm ${disabled ? "opacity-40" : ""}`}>
      <span>{label}</span>
      <Button type="button" variant={checked ? "default" : "outline"} size="sm" disabled={disabled} onClick={() => onChange(!checked)}>
        {checked ? "On" : "Off"}
      </Button>
    </label>
  );
}

// --- Mentions (folded in from the former /mentions page) ---------------------
// Mentions are a distinct data source (someone @ed you in an issue/review/
// change) from the notification inbox, but they're the same job — "what needs
// my attention" — so they live as a tab here rather than a separate nav entry.

const SOURCE_LABEL: Record<string, string> = {
  issue: "Issue",
  issue_comment: "Issue comment",
  review: "Review",
  review_comment: "Review comment",
  change: "Change",
};

// Resolve a mention to the best deep link we can build. Only `change` carries an
// id that addresses a dashboard route directly; issues/comments record the ROW
// id (not the number/parent the route needs), so those fall back to the repo.
function mentionHref(m: Mention, repoPath: string | null): string | null {
  if (!repoPath) return null;
  if (m.sourceKind === "change") return `/repos/${repoPath}/changes/${m.sourceId}`;
  if (m.sourceKind === "issue" || m.sourceKind === "issue_comment") return `/repos/${repoPath}/issues`;
  if (m.sourceKind === "review" || m.sourceKind === "review_comment") return `/repos/${repoPath}/changes`;
  return `/repos/${repoPath}`;
}

function MentionsTab() {
  const [mentions, setMentions] = useState<Mention[] | null>(null);
  const [repos, setRepos] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [m, r] = await Promise.all([api.listMentions(), api.listRepos().catch(() => ({ repos: [] as Repo[] }))]);
      setMentions(m.mentions);
      const map: Record<string, string> = {};
      for (const repo of r.repos) {
        const ns = repo.namespaceName ?? repo.namespaceId;
        map[repo.id] = `${ns}/${repo.name}`;
      }
      setRepos(map);
    } catch (e) {
      setError((e as Error).message || "Couldn't load your mentions.");
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function ack(id: string) { await api.ackMention(id); void load(); }

  return (
    <div className="space-y-3 max-w-2xl">
      <p className="text-sm text-muted-foreground">People (or agents) that @ed you.</p>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {loading && <div className="text-muted-foreground text-sm">Loading…</div>}
      {!loading && !error && mentions?.length === 0 && (
        <div className="py-16 text-center text-sm text-muted-foreground">No mentions yet.</div>
      )}
      <div className="space-y-2">
        {(mentions ?? []).map(m => {
          const repoPath = m.repoId ? (repos[m.repoId] ?? null) : null;
          const href = mentionHref(m, repoPath);
          const exact = m.sourceKind === "change";
          return (
            <Card key={m.id} className={m.acknowledged ? "opacity-60" : ""}>
              <CardContent className="flex items-center justify-between gap-3 pt-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{SOURCE_LABEL[m.sourceKind] ?? m.sourceKind}</Badge>
                    {repoPath && <code className="font-mono text-xs text-muted-foreground truncate">{repoPath}</code>}
                    <span className="text-xs text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</span>
                    {m.acknowledged && <Badge variant="secondary">Acknowledged</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground">From <span className="text-foreground">{m.authorKind === "agent" ? "an agent" : "a teammate"}</span></div>
                  {href ? (
                    <Link href={href} className="inline-flex text-sm text-primary hover:underline">
                      {exact ? "Open change →" : repoPath ? `Open ${repoPath} →` : "Open →"}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">No linked repo.</span>
                  )}
                </div>
                {!m.acknowledged && <Button size="sm" variant="outline" onClick={() => void ack(m.id)}>Mark read</Button>}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
