"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Agent } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConnectAgentCard } from "@/components/connect-agent-card";
import { NewAgentDialog } from "@/components/new-agent-dialog";
import { Plus, Bot, Trash2, TriangleAlert } from "lucide-react";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [repoCount, setRepoCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [standing, setStanding] = useState<Array<{ id: string; agentId: string | null; repoNs: string; repoName: string; trigger: string; status?: string }>>([]);
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);
  const [removing, setRemoving] = useState(false);

  async function load() {
    const [a, r, sa] = await Promise.all([
      api.listAgents(),
      api.listRepos().catch(() => ({ repos: [] })),
      api.listMyStandingAgents().catch(() => ({ standingAgents: [] })),
    ]);
    setAgents(a.agents);
    setRepoCount(r.repos.length);
    setStanding((sa.standingAgents as typeof standing) ?? []);
  }
  useEffect(() => { load().catch(e => setError((e as Error).message)); }, []);

  async function runNow(sr: { id: string; repoNs: string; repoName: string }) {
    setRunBusy(sr.id); setError(null);
    try { await api.runStandingAgent(sr.repoNs, sr.repoName, sr.id); }
    catch (e) { setError((e as Error).message); }
    finally { setTimeout(() => setRunBusy(null), 1200); }
  }

  async function removeAgent() {
    if (!confirmDelete) return;
    setRemoving(true); setError(null);
    try { await api.deleteAgent(confirmDelete.id); setConfirmDelete(null); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setRemoving(false); }
  }

  // First-run onboarding: a logged-in user with no agents and no visible
  // repos sees the same "Connect your first agent" card as the repos page.
  const showOnboarding = agents !== null && agents.length === 0 && repoCount === 0;

  // v3 IA (docs/redesign-v3.md §3): one identity kind, two run modes.
  // WRAPPERS have no standing deployment — the human runs them locally by
  // pasting the token into a tool. STANDING agents have ≥1 deployment that
  // ClawHub runs. Role-minted workers fold under Standing (they belong to a
  // deployment either way).
  const identities = (agents ?? []).filter(a => !a.roleName);
  const deployedAgentIds = new Set(standing.map(sr => sr.agentId).filter((x): x is string => !!x));
  const wrappers = identities
    .filter(a => !deployedAgentIds.has(a.id))
    // The default personal agent sorts first.
    .sort((x, y) => Number(!!y.isPersonal) - Number(!!x.isPersonal));
  const standingIdentities = identities.filter(a => deployedAgentIds.has(a.id));
  const roleMinted = (agents ?? []).filter(a => a.roleName);

  function identityCard(a: Agent, kind: "wrapper" | "standing") {
    const mine = standing.filter(sr => sr.agentId === a.id);
    return (
      // `relative` so the Remove button can sit as a SIBLING of the Link
      // (a <button> nested in an <a> is invalid HTML + a hydration bug).
      <li key={a.id} className="relative group">
        <Link href={`/agents/${a.id}`} className="block">
          <Card className="h-full transition-colors group-hover:border-primary/40">
            <CardContent className="pt-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <Bot className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold truncate">{a.name}</span>
                    {a.isPersonal && <Badge variant="outline" className="text-[10px]">default</Badge>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {a.accessRoleName
                      ? <Badge variant="secondary" className="text-[10px]">{a.accessRoleName}</Badge>
                      : <>
                          {a.capabilities?.push && <Badge variant="secondary" className="text-[10px]">push</Badge>}
                          {a.capabilities?.review && <Badge variant="secondary" className="text-[10px]">review</Badge>}
                        </>}
                    {kind === "standing" && (
                      <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">runs: {mine.length} repo{mine.length === 1 ? "" : "s"}</Badge>
                    )}
                  </div>
                  {kind === "wrapper" && (
                    <p className="mt-2 text-xs text-muted-foreground">Paste its token into a local tool — pushes commit as this identity.</p>
                  )}
                </div>
                {/* spacer so the title row clears the absolute Remove button */}
                <div className="w-7 shrink-0" />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-3">
                <div>
                  <div className="text-lg font-semibold leading-none">{a.stats.changesOpened}</div>
                  <div className="mt-1 text-xs text-muted-foreground">changes opened</div>
                </div>
                <div>
                  <div className="text-lg font-semibold leading-none">{a.stats.reviewsSubmitted}</div>
                  <div className="mt-1 text-xs text-muted-foreground">reviews submitted</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
        {/* The default personal agent ships DORMANT — surface that + the one
            click to deployment. Sits OUTSIDE the Link (anchor-in-anchor is
            invalid HTML). */}
        {kind === "wrapper" && a.isPersonal && (
          <div className="mt-1 flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-xs">
            <span className="text-muted-foreground">dormant — zero runs, zero spend</span>
            <Link href="/agents/standing" className="ml-auto inline-flex h-6 items-center rounded-md border border-primary/40 px-2 font-medium text-primary transition-colors hover:bg-primary/10">
              Deploy
            </Link>
          </div>
        )}
        {/* Where it runs — with a real Run now, so the create-flow's
            "use Run now on the agent card" is true. Sits OUTSIDE the
            Link (button-in-anchor is invalid HTML). */}
        {kind === "standing" && mine.length > 0 && (
          <div className="mt-1 space-y-1">
            {mine.map(sr => (
              <div key={sr.id} className="flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-xs">
                <span className="font-mono truncate">{sr.repoNs}/{sr.repoName}</span>
                <span className="text-muted-foreground">· {sr.trigger}</span>
                <button
                  type="button"
                  className="ml-auto cursor-pointer text-primary hover:underline disabled:opacity-50"
                  disabled={runBusy === sr.id}
                  onClick={() => void runNow(sr)}
                >
                  {runBusy === sr.id ? "Queued…" : "Run now"}
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          title={`Remove ${a.name}`}
          aria-label={`Remove ${a.name}`}
          onClick={() => setConfirmDelete(a)}
          className="absolute top-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-40 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </li>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground mt-1">The AI identities that push code and submit reviews on your behalf — every one is yours to govern.</p>
        </div>
        {!showOnboarding && (
          <Button size="sm" className="gap-2" onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> New agent</Button>
        )}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!agents ? <div className="text-muted-foreground">Loading…</div>
        : showOnboarding ? (
          <ConnectAgentCard onConnected={() => void load()} />
        ) : agents.length === 0 ? (
          <Card><CardContent className="pt-6 text-center text-muted-foreground">No agents yet. Create one with the New agent button.</CardContent></Card>
        ) : (
          <>
          {/* v3 IA: one identity kind, two run modes — wrappers the human runs
              locally vs standing agents ClawHub runs. Role-minted deployment
              workers fold under Standing — never intermixed as peers. */}
          {wrappers.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Wrappers — run on your machine</h2>
              <p className="text-xs text-muted-foreground">Identities you drive from a local tool (Claude Code, Cursor, a script). ClawHub holds no runtime for them — just the identity and its permissions.</p>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {wrappers.map(a => identityCard(a, "wrapper"))}
              </ul>
            </div>
          )}
          {(standingIdentities.length > 0 || roleMinted.length > 0) && (
            <div className="space-y-2 pt-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Standing — ClawHub runs them</h2>
                <Link href="/agents/standing" className="text-xs text-primary hover:underline">manage deployments →</Link>
              </div>
              <p className="text-xs text-muted-foreground">Deployed agents ClawHub runs on their cadence — no machine of yours involved.</p>
              {standingIdentities.length > 0 && (
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {standingIdentities.map(a => identityCard(a, "standing"))}
                </ul>
              )}
              {roleMinted.length > 0 && (
                <div className="space-y-2 pt-2">
                  <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Deployed by roles</h3>
                  <p className="text-xs text-muted-foreground">Worker identities your role deployments (Loops, reviewers) push as. They belong to the deployment — pause or remove them there.</p>
                  <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {roleMinted.map(a => (
                      <li key={a.id}>
                        <Link href={`/agents/${a.id}`} className="flex items-center gap-2 rounded-md border bg-card/50 px-3 py-2 text-sm hover:border-primary/40">
                          <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="font-mono truncate">{a.name}</span>
                          <Badge variant="outline" className="text-[10px] shrink-0">role</Badge>
                          <span className="ml-auto text-xs text-muted-foreground shrink-0">{a.stats.changesOpened} changes · {a.stats.reviewsSubmitted} reviews</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          </>
        )}

      <NewAgentDialog open={newOpen} onOpenChange={setNewOpen} onCreated={() => void load()} />

      {/* Remove (archive) an agent — token revoked + hidden from the list; the
          change/review history it authored is preserved. */}
      <Dialog open={!!confirmDelete} onOpenChange={v => { if (!v && !removing) setConfirmDelete(null); }}>
        <DialogContent>
          {confirmDelete && (
            <>
              <DialogHeader><DialogTitle>Remove agent “{confirmDelete.name}”?</DialogTitle></DialogHeader>
              <Alert variant="destructive">
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription>
                  This <strong>revokes the agent&apos;s token</strong> and removes it from your list. Any standing
                  deployment it has stops working. The changes and reviews it already authored are kept.
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <Button variant="ghost" disabled={removing} onClick={() => setConfirmDelete(null)}>Cancel</Button>
                <Button variant="destructive" disabled={removing} onClick={removeAgent}>{removing ? "Removing…" : "Remove agent"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
