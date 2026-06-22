"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api, type Repo } from "@/lib/api";
import { getAgentToken } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Activity, Boxes, Brain, Code2, Eye, GitFork, GitPullRequest, CircleDot, Milestone, Rocket, ScrollText, Settings, Shield, Star } from "lucide-react";

/**
 * GitHub-style repo hub header: identity row with star/watch/fork state, then
 * a tab row that owns all repo-scoped navigation (so repo features live here,
 * not in the global sidebar).
 */
export function RepoHeader({ ns, repo, data, counts }: {
  ns: string; repo: string; data?: Repo | null;
  counts?: { changes?: number; issues?: number };
}) {
  const pathname = usePathname();
  const base = `/repos/${ns}/${repo}`;
  const [social, setSocial] = useState<{ starred: boolean; watching: boolean; stars: number; watchers: number; forks: number } | null>(null);
  const [forkOpen, setForkOpen] = useState(false);
  const [forks, setForks] = useState<Repo[] | null>(null);
  const [forkName, setForkName] = useState("");
  const [forkPending, setForkPending] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const hasAgent = typeof window !== "undefined" && !!getAgentToken();

  useEffect(() => {
    api.getSocial(ns, repo).then(setSocial).catch(() => setSocial(null));
  }, [ns, repo]);

  function openForkDialog() {
    setForkOpen(true);
    setForkError(null);
    setForks(null);
    api.listForks(ns, repo).then(r => setForks(r.forks)).catch(() => setForks([]));
  }

  async function onCreateFork() {
    setForkPending(true); setForkError(null);
    try {
      await api.forkRepo(ns, repo, forkName.trim() || undefined);
      setForkName("");
      const r = await api.listForks(ns, repo);
      setForks(r.forks);
      // Reflect the new fork in the header count.
      setSocial(s => s && { ...s, forks: s.forks + 1 });
    } catch (e) {
      setForkError((e as Error).message);
    } finally {
      setForkPending(false);
    }
  }

  async function toggle(kind: "star" | "watch") {
    if (!social) return;
    const on = kind === "star" ? !social.starred : !social.watching;
    // Optimistic; humans only — agent tokens get a 401 we surface by reverting.
    setSocial(s => s && (kind === "star"
      ? { ...s, starred: on, stars: s.stars + (on ? 1 : -1) }
      : { ...s, watching: on, watchers: s.watchers + (on ? 1 : -1) }));
    try { await (kind === "star" ? api.star(ns, repo, on) : api.watch(ns, repo, on)); }
    catch { api.getSocial(ns, repo).then(setSocial).catch(() => {}); }
  }

  const TABS = [
    { href: base, label: "Code", icon: Code2, exact: false, also: [`${base}/tree`, `${base}/blob`] },
    { href: `${base}/changes`, label: "Changes", icon: GitPullRequest, count: counts?.changes },
    { href: `${base}/issues`, label: "Issues", icon: CircleDot, count: counts?.issues },
    { href: `${base}/releases`, label: "Releases", icon: Rocket },
    { href: `${base}/security`, label: "Security", icon: Shield },
    { href: `${base}/packages`, label: "Packages", icon: Boxes },
    { href: `${base}/milestones`, label: "Milestones", icon: Milestone },
    { href: `${base}/memory`, label: "Memory", icon: Brain },
    { href: `${base}/activity`, label: "Activity", icon: Activity },
    { href: `${base}/audit`, label: "Audit", icon: ScrollText },
    { href: `${base}/settings`, label: "Settings", icon: Settings },
  ];
  const isActive = (t: typeof TABS[number]) =>
    t.href === base
      ? pathname === base || (t.also ?? []).some(p => pathname.startsWith(p))
      : pathname.startsWith(t.href);

  return (
    <div className="space-y-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight min-w-0 break-all">
          <Link href="/repos" className="text-muted-foreground hover:text-foreground">{ns}</Link>
          <span className="text-muted-foreground/60 mx-1">/</span>
          <Link href={base} className="hover:text-primary">{repo}</Link>
        </h1>
        {data && <Badge variant="outline" className="text-[10px]">{data.isPublic ? "public" : "private"}</Badge>}
        {data?.forkOfRepoId && <Badge variant="outline" className="text-[10px]">fork</Badge>}

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => toggle("star")}>
            <Star className={`h-3.5 w-3.5 ${social?.starred ? "fill-yellow-400 text-yellow-400" : ""}`} />
            {social?.starred ? "Starred" : "Star"}
            <span className="text-xs text-muted-foreground">{social?.stars ?? data?.starsCount ?? 0}</span>
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => toggle("watch")}>
            <Eye className={`h-3.5 w-3.5 ${social?.watching ? "text-primary" : ""}`} />
            {social?.watching ? "Watching" : "Watch"}
            <span className="text-xs text-muted-foreground">{social?.watchers ?? data?.watchersCount ?? 0}</span>
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={openForkDialog} title="Forks">
            <GitFork className="h-3.5 w-3.5" />
            Fork
            <span className="text-xs text-muted-foreground">{social?.forks ?? 0}</span>
          </Button>
        </div>
      </div>
      {data?.description && <p className="text-muted-foreground text-sm mt-1">{data.description}</p>}

      <div className="flex items-center gap-1 mt-4 border-b overflow-x-auto">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = isActive(t);
          return (
            <Link key={t.label} href={t.href}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
                active ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}>
              <Icon className="h-4 w-4" /> {t.label}
              {typeof t.count === "number" && <span className="text-xs rounded-full bg-muted px-1.5">{t.count}</span>}
            </Link>
          );
        })}
      </div>

      <Dialog open={forkOpen} onOpenChange={setForkOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Fork {ns}/{repo}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm text-muted-foreground">Forks of this repo</div>
              {forks === null ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : forks.length === 0 ? (
                <div className="text-sm text-muted-foreground">No forks yet.</div>
              ) : (
                <ul className="space-y-1">
                  {forks.map(f => (
                    <li key={f.id}>
                      <Link
                        href={`/repos/${f.namespaceName ?? ns}/${f.name}`}
                        onClick={() => setForkOpen(false)}
                        className="inline-flex items-center gap-1.5 text-sm font-mono text-primary hover:underline">
                        <GitFork className="h-3.5 w-3.5" />
                        {f.namespaceName ?? "?"}/{f.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2 pt-2 border-t border-border">
              <Label htmlFor="fork-name">Create a fork</Label>
              {hasAgent ? (
                <>
                  <Input
                    id="fork-name"
                    value={forkName}
                    onChange={e => setForkName(e.target.value)}
                    placeholder={`${repo} (optional new name)`}
                    disabled={forkPending}
                  />
                  <p className="text-xs text-muted-foreground">
                    Forking creates a repo — an agent action. The fork lands in your connected agent&apos;s namespace.
                  </p>
                  {forkError && <p className="text-xs text-destructive">{forkError}</p>}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only agents commit, so forking needs a connected agent.{" "}
                  <Link href="/agents" onClick={() => setForkOpen(false)} className="text-primary underline underline-offset-2">
                    Connect an agent first
                  </Link>.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setForkOpen(false)}>Close</Button>
            {hasAgent && (
              <Button onClick={onCreateFork} disabled={forkPending}>
                {forkPending ? "Forking…" : "Create fork"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
