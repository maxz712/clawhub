"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, UserPlus, Bot, User } from "lucide-react";

type Reviewer = { kind: "agent" | "human"; id: string };
type Collab = { id: string; agentId: string; role: "writer" | "reviewer"; name?: string | null };

/**
 * Request-reviewers control for the Change actions sidebar. Wires the existing
 * api.requestReviewers (which had zero callers) and renders the change's current
 * requestedReviewers. Candidates are the repo's collaborator agents; requesting
 * a reviewer now also delivers an inbox notification + email (Batch 3). The
 * server treats requestReviewers as the full desired set, so add/remove submit
 * the recomputed list.
 */
export function RequestReviewersCard({ ns, repo, changeId, reviewers, onChanged }: {
  ns: string; repo: string; changeId: string; reviewers: Reviewer[]; onChanged: () => void;
}) {
  const [collabs, setCollabs] = useState<Collab[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listCollaborators(ns, repo).then(r => setCollabs(r.collaborators)).catch(() => setCollabs([]));
  }, [ns, repo]);

  const nameFor = useCallback((rv: Reviewer) => {
    if (rv.kind === "agent") return collabs.find(c => c.agentId === rv.id)?.name ?? rv.id.slice(0, 8);
    return rv.id.slice(0, 8);
  }, [collabs]);

  async function submit(next: Reviewer[]) {
    setBusy(true); setError(null);
    try { await api.requestReviewers(ns, repo, changeId, next); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const requestedAgentIds = new Set(reviewers.filter(r => r.kind === "agent").map(r => r.id));
  const candidates = collabs.filter(c => !requestedAgentIds.has(c.agentId));

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Reviewers</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {reviewers.length === 0
          ? <p className="text-xs text-muted-foreground">No reviewers requested yet.</p>
          : (
            <div className="flex flex-wrap gap-1.5">
              {reviewers.map(rv => (
                <Badge key={`${rv.kind}:${rv.id}`} variant="secondary" className="gap-1 pr-1" title={rv.kind === "human" ? "Human reviewer" : "Agent reviewer"}>
                  {rv.kind === "agent" ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
                  <span className="font-mono text-[11px]">{rv.kind === "agent" ? "@" : ""}{nameFor(rv)}</span>
                  <button
                    aria-label="Remove reviewer"
                    disabled={busy}
                    onClick={() => void submit(reviewers.filter(r => !(r.kind === rv.kind && r.id === rv.id)))}
                    className="rounded hover:bg-background/60"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

        {candidates.length > 0 && (
          <Select
            value=""
            onValueChange={agentId => { if (agentId) void submit([...reviewers, { kind: "agent", id: agentId }]); }}
          >
            <SelectTrigger className="h-8 text-xs" disabled={busy}>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground"><UserPlus className="h-3.5 w-3.5" /> <SelectValue placeholder="Request a reviewer agent" /></span>
            </SelectTrigger>
            <SelectContent>
              {candidates.map(c => (
                <SelectItem key={c.agentId} value={c.agentId}>{c.name ?? c.agentId.slice(0, 8)} <span className="text-muted-foreground">({c.role})</span></SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
