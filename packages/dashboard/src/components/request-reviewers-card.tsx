"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type StandingAgent } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, UserPlus, Bot, User, Zap, Settings } from "lucide-react";

type Reviewer = { kind: "agent" | "human"; id: string };
type Collab = { agentId: string; role: "writer" | "reviewer"; name?: string | null };

/**
 * Reviewers control for the Change sidebar. Two distinct ideas, made legible:
 *
 *  - **Auto-reviewers** — review-mode standing agents wired to `change.opened`.
 *    They run on EVERY change with no per-change action ("set up once, runs
 *    automatically"). Shown read-only here so a requester knows the change is
 *    already being reviewed.
 *  - **Requested reviewers** — a one-off ask for a specific agent on THIS change.
 *    Requesting an agent that is a standing reviewer now actually DISPATCHES it
 *    (server-side); a plain collaborator agent is advisory (ClawHub can't run a
 *    harness it wasn't given).
 */
export function RequestReviewersCard({ ns, repo, changeId, reviewers, onChanged }: {
  ns: string; repo: string; changeId: string; reviewers: Reviewer[]; onChanged: () => void;
}) {
  const [collabs, setCollabs] = useState<Collab[]>([]);
  const [standing, setStanding] = useState<StandingAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only AGENT collaborators are reviewer candidates here (a reviewer agent
    // submits verdicts). Human collaborators review through the UI directly.
    api.listCollaborators(ns, repo)
      .then(r => setCollabs(r.collaborators.filter(c => c.kind === "agent" && c.agentId).map(c => ({ agentId: c.agentId as string, role: c.role, name: c.name ?? c.agentName }))))
      .catch(() => setCollabs([]));
    // Best-effort + logout-safe: listing standing agents is operator-gated, so a
    // non-operator viewer just won't see the auto-reviewer section. listStanding-
    // AgentsSafe uses a raw fetch so its 401 can't trip the global session-expiry
    // logout (a plain request() 401 would bounce the viewer to /login).
    api.listStandingAgentsSafe(ns, repo).then(setStanding).catch(() => setStanding([]));
  }, [ns, repo]);

  // An auto-reviewer = an enabled review-mode standing agent that fires on
  // change.opened, i.e. it reviews every change with no per-change action.
  const autoReviewers = standing.filter(s => s.enabled && s.mode === "review" && s.trigger === "event" && s.event === "change.opened");
  const standingAgentIds = new Set(standing.map(s => s.agentId));

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
  // Don't offer an agent that's already an auto-reviewer (it runs anyway) or
  // already requested.
  const autoAgentIds = new Set(autoReviewers.map(s => s.agentId));
  const candidates = collabs.filter(c => !requestedAgentIds.has(c.agentId) && !autoAgentIds.has(c.agentId));

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Reviewers</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {autoReviewers.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Zap className="h-3 w-3 text-primary" /> Auto-review
            </div>
            <div className="flex flex-wrap gap-1.5">
              {autoReviewers.map(s => (
                <Badge key={s.id} variant="secondary" className="gap-1" title="Reviews every change automatically (review-mode standing agent on change.opened)">
                  <Bot className="h-3 w-3" />
                  <span className="font-mono text-[11px]">@{s.name}</span>
                  <span className="text-[9px] uppercase tracking-wider text-primary">auto</span>
                </Badge>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">Runs on every change — no need to request.</p>
          </div>
        )}

        <div className="space-y-1.5">
          {autoReviewers.length > 0 && (
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Requested</div>
          )}
          {reviewers.length === 0
            ? <p className="text-xs text-muted-foreground">No reviewers requested yet.</p>
            : (
              <div className="flex flex-wrap gap-1.5">
                {reviewers.map(rv => {
                  const runnable = rv.kind === "agent" && standingAgentIds.has(rv.id);
                  return (
                    <Badge key={`${rv.kind}:${rv.id}`} variant="secondary" className="gap-1 pr-1"
                      title={rv.kind === "human" ? "Human reviewer" : runnable ? "Standing reviewer — dispatched on request" : "Agent reviewer (advisory — not a standing agent)"}>
                      {rv.kind === "agent" ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
                      <span className="font-mono text-[11px]">{rv.kind === "agent" ? "@" : ""}{nameFor(rv)}</span>
                      {runnable && <span className="text-[9px] uppercase tracking-wider text-primary">runs</span>}
                      <button
                        aria-label="Remove reviewer"
                        disabled={busy}
                        onClick={() => void submit(reviewers.filter(r => !(r.kind === rv.kind && r.id === rv.id)))}
                        className="rounded hover:bg-background/60"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  );
                })}
              </div>
            )}
        </div>

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
                <SelectItem key={c.agentId} value={c.agentId}>
                  {c.name ?? c.agentId.slice(0, 8)} <span className="text-muted-foreground">({standingAgentIds.has(c.agentId) ? "runs on request" : c.role})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <a href={`/repos/${ns}/${repo}/settings`} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <Settings className="h-3 w-3" /> Set up an auto-reviewer
        </a>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
