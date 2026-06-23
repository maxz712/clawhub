"use client";

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GitFork } from "lucide-react";

type IncomingProposal = {
  id: string; changeId: string; targetBranch: string; status: string;
  createdAt: string; intent: string; sourceBranch: string; sourceRepoId: string;
};

export default function IncomingProposalsPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const router = useRouter();
  const [proposals, setProposals] = useState<IncomingProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.listIncomingProposals(ns, repo);
    setProposals(r.proposals);
  }, [ns, repo]);

  useEffect(() => { load().catch(e => setError((e as Error).message)); }, [load]);

  async function onAccept(p: IncomingProposal) {
    setPendingId(p.id); setError(null);
    try {
      const { changeId } = await api.acceptIncomingProposal(ns, repo, p.id);
      router.push(`/repos/${ns}/${repo}/changes/${changeId}`);
    } catch (e) {
      setError((e as Error).message);
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Incoming proposals</h1>
        <p className="text-muted-foreground text-sm">
          Cross-repo proposals from forks targeting this repo. Accepting one materializes a reviewable Change here
          (you need write access).
        </p>

        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

        {!proposals ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : proposals.length === 0 ? (
          <div className="p-6 text-center rounded border bg-card text-muted-foreground space-y-1.5">
            <div>No incoming proposals.</div>
            <div className="text-sm">
              When a fork proposes a change to this repo, it shows up here for a maintainer to accept.
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {proposals.map(p => (
              <li key={p.id} className="p-3 rounded border bg-card">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="font-medium flex items-center gap-1.5">
                      <GitFork className="h-4 w-4 text-muted-foreground shrink-0" />
                      {p.intent || "(no intent declared)"}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <code className="font-mono">{p.sourceBranch}</code>
                      <span>→</span>
                      <code className="font-mono">{p.targetBranch}</code>
                      <Badge variant="secondary" className="text-[9px] uppercase">{p.status}</Badge>
                      <span className="ml-auto">{new Date(p.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="shrink-0">
                    {/* Only OPEN proposals are listed; accepting materializes a
                        Change and navigates to it (the row disappears on reload). */}
                    <Button size="sm" disabled={pendingId === p.id} onClick={() => onAccept(p)}>
                      {pendingId === p.id ? "Accepting…" : "Accept"}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
