"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Agent } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConnectAgentCard } from "@/components/connect-agent-card";
import { NewAgentDialog } from "@/components/new-agent-dialog";
import { CopyBlock } from "@/components/copy-block";
import { Plus, Key, Bot, Trash2, TriangleAlert } from "lucide-react";

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

  // First-run onboarding: a logged-in user with no claimed agents and no visible
  // repos sees the same "Connect your first agent" card as the repos page.
  const showOnboarding = agents !== null && agents.length === 0 && repoCount === 0;

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
          <Card><CardContent className="pt-6 text-center text-muted-foreground">No agents yet. Register one above, or claim one with its claim token.</CardContent></Card>
        ) : (
          <>
          {/* Two-kinds model (docs/agents-ux.md): identities first, role-minted
              deployment workers grouped apart — never intermixed as peers. */}
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {agents.filter(a => !a.roleName).map(a => (
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
                            {a.isPersonal && <Badge variant="outline" className="text-[10px]">personal</Badge>}
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {a.accessRoleName
                              ? <Badge variant="secondary" className="text-[10px]">{a.accessRoleName}</Badge>
                              : <>
                                  {a.capabilities?.push && <Badge variant="secondary" className="text-[10px]">push</Badge>}
                                  {a.capabilities?.review && <Badge variant="secondary" className="text-[10px]">review</Badge>}
                                </>}
                            {(() => {
                              const mine = standing.filter(sr => sr.agentId === a.id);
                              if (!mine.length) return <Badge variant="outline" className="text-[10px]">runs: local</Badge>;
                              return <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">runs: {mine.length} repo{mine.length === 1 ? "" : "s"}</Badge>;
                            })()}
                          </div>
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
                {/* Where it runs — with a real Run now, so the create-flow's
                    "use Run now on the agent card" is true. Sits OUTSIDE the
                    Link (button-in-anchor is invalid HTML). */}
                {standing.some(sr => sr.agentId === a.id) && (
                  <div className="mt-1 space-y-1">
                    {standing.filter(sr => sr.agentId === a.id).map(sr => (
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
            ))}
          </ul>
          {agents.some(a => a.roleName) && (
            <div className="space-y-2 pt-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Deployed by roles</h2>
                <Link href="/agents/standing" className="text-xs text-primary hover:underline">manage deployments →</Link>
              </div>
              <p className="text-xs text-muted-foreground">Worker identities your role deployments (Loops, reviewers) push as. They belong to the deployment — pause or remove them there.</p>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {agents.filter(a => a.roleName).map(a => (
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
