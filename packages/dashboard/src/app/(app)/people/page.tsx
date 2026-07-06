"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type IdentityRow } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { IdentityChip } from "@/components/identity-chip";
import { Users } from "lucide-react";

/**
 * The People directory (v3 identities). Common-context visibility: only
 * identities sharing a repo or org with you are listed — never a global
 * directory. Humans and agents are the same kind of row; the bot marker is
 * the only visual difference.
 */
export default function PeoplePage() {
  const [rows, setRows] = useState<IdentityRow[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api.listIdentities(q || undefined)
        .then(r => { setRows(r.identities); setError(null); })
        .catch(e => setError(e instanceof Error ? e.message : "failed to load"));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);

  const humans = (rows ?? []).filter(r => r.kind === "human");
  const agents = (rows ?? []).filter(r => r.kind === "agent");

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold flex items-center gap-2"><Users className="h-5 w-5" /> People</h1>
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search people and agents…" className="max-w-xs" />
      </div>
      <p className="text-sm text-muted-foreground">
        Everyone you share a repo or org with — humans and agents alike. Profiles outside your shared context are not listed.
      </p>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {rows === null && !error && <div className="text-sm text-muted-foreground">Loading…</div>}
      {rows !== null && rows.length === 0 && (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
          No shared identities yet — collaborate on a repo and its people show up here.
        </CardContent></Card>
      )}
      {[{ title: "Humans", list: humans }, { title: "Agents", list: agents }].map(section => section.list.length > 0 && (
        <div key={section.title} className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">{section.title}</h2>
          <Card>
            <CardContent className="divide-y divide-border p-0">
              {section.list.map(i => (
                <Link key={`${i.kind}:${i.id}`} href={`/people/${encodeURIComponent(i.handle)}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent/50 transition-colors">
                  <div className="min-w-0">
                    <IdentityChip handle={i.handle} displayName={i.displayName} avatarUrl={i.avatarUrl}
                      kind={i.kind} isSystem={i.isSystem} size="md" link={false} />
                    <div className="text-xs text-muted-foreground truncate mt-0.5 font-mono">{i.handle}</div>
                  </div>
                  <div className="text-xs text-muted-foreground shrink-0">
                    {i.sharedRepoCount ? `${i.sharedRepoCount} shared repo${i.sharedRepoCount === 1 ? "" : "s"}` : ""}
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
}
