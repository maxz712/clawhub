"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Mention, type Repo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

// Human-readable label for each mention source.
const SOURCE_LABEL: Record<string, string> = {
  issue: "Issue",
  issue_comment: "Issue comment",
  review: "Review",
  review_comment: "Review comment",
  change: "Change",
};

// Resolve a mention to the best deep link we can build.
//
// Only `change` carries an id that addresses a dashboard route directly
// (`sourceId` is the change id → /changes/<id>). Issues/comments record the
// ROW id, but the dashboard routes issues by number and threads by change id —
// neither of which the mention row carries — so those fall back to the repo.
// When we have no repo at all, there's nothing to link to.
function mentionHref(m: Mention, repoPath: string | null): string | null {
  if (!repoPath) return null;
  if (m.sourceKind === "change") return `/repos/${repoPath}/changes/${m.sourceId}`;
  if (m.sourceKind === "issue" || m.sourceKind === "issue_comment") return `/repos/${repoPath}/issues`;
  if (m.sourceKind === "review" || m.sourceKind === "review_comment") return `/repos/${repoPath}/changes`;
  return `/repos/${repoPath}`;
}

export default function MentionsPage() {
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [repos, setRepos] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [m, r] = await Promise.all([api.listMentions(), api.listRepos().catch(() => ({ repos: [] as Repo[] }))]);
      setMentions(m.mentions);
      // Build repoId -> "<ns>/<name>" map for deep links + display.
      const map: Record<string, string> = {};
      for (const repo of r.repos) {
        const ns = repo.namespaceName ?? repo.namespaceId;
        map[repo.id] = `${ns}/${repo.name}`;
      }
      setRepos(map);
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function ack(id: string) { await api.ackMention(id); void load(); }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Mentions</h1>
        <p className="text-sm text-muted-foreground">People (or agents) that @ed you.</p>
      </div>
      {loading && <div className="text-muted-foreground text-sm">Loading…</div>}
      {!loading && mentions.length === 0 && <div className="text-muted-foreground text-sm">No mentions yet.</div>}
      <div className="space-y-2">
        {mentions.map(m => {
          const repoPath = m.repoId ? (repos[m.repoId] ?? null) : null;
          const href = mentionHref(m, repoPath);
          // The change link is exact; everything else lands on the repo's list
          // page (issues/changes) because the mention row doesn't carry the
          // issue number / parent change id the detail route needs.
          const exact = m.sourceKind === "change";
          return (
            <Card key={m.id} className={m.acknowledged ? "opacity-60" : ""}>
              <CardContent className="flex items-center justify-between gap-3 pt-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{SOURCE_LABEL[m.sourceKind] ?? m.sourceKind}</Badge>
                    {repoPath && <code className="font-mono text-xs text-muted-foreground truncate">{repoPath}</code>}
                    <span className="text-xs font-mono text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</span>
                    {m.acknowledged && <Badge variant="secondary">Acknowledged</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    From <code className="font-mono text-foreground">{m.authorKind}</code>
                  </div>
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
