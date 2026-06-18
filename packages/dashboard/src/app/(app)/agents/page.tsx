"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Agent } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectAgentCard } from "@/components/connect-agent-card";
import { CopyBlock } from "@/components/copy-block";
import { Plus, Key } from "lucide-react";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [repoCount, setRepoCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [name, setName] = useState("");
  const [claimToken, setClaimToken] = useState("");
  const [issued, setIssued] = useState<{ token: string; claimToken?: string; expiresAt?: string; claimed: boolean; name: string } | null>(null);

  async function load() {
    const [a, r] = await Promise.all([
      api.listAgents(),
      api.listRepos().catch(() => ({ repos: [] })),
    ]);
    setAgents(a.agents);
    setRepoCount(r.repos.length);
  }
  useEffect(() => { load().catch(e => setError((e as Error).message)); }, []);

  async function register() {
    if (!name) return;
    try {
      const r = await api.registerAgent({ name });
      setIssued({ token: r.token, claimToken: r.claim_token, expiresAt: r.claim_token_expires_at, claimed: r.claimed, name: r.agent.name });
      setName("");
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function claim() {
    try { await api.claimAgent(claimToken); setClaimToken(""); setClaimOpen(false); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  // First-run onboarding: a logged-in user with no claimed agents and no visible
  // repos sees the same "Connect your first agent" card as the repos page.
  const showOnboarding = agents !== null && agents.length === 0 && repoCount === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground mt-1">Agents you&apos;ve registered or claimed.</p>
        </div>
        {!showOnboarding && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setClaimOpen(true)}><Key className="h-4 w-4" /> Claim</Button>
            <Dialog open={claimOpen} onOpenChange={setClaimOpen}>
              <DialogContent>
                <DialogHeader><DialogTitle>Claim an agent</DialogTitle></DialogHeader>
                <div className="space-y-2">
                  <Label>Claim token</Label>
                  <Input value={claimToken} onChange={e => setClaimToken(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Claim tokens expire after ~48 hours.</p>
                </div>
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setClaimOpen(false)}>Cancel</Button>
                  <Button onClick={claim} disabled={!claimToken}>Claim</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button size="sm" className="gap-2" onClick={() => setRegOpen(true)}><Plus className="h-4 w-4" /> Register</Button>
            <Dialog open={regOpen} onOpenChange={v => { setRegOpen(v); if (!v) setIssued(null); }}>
              <DialogContent>
                <DialogHeader><DialogTitle>Register an agent</DialogTitle></DialogHeader>
                {issued ? (
                  <div className="space-y-3 text-sm">
                    <p>Agent <code className="font-mono text-primary">{issued.name}</code> created.</p>
                    <CopyBlock label="Token (save now — won't be shown again)" value={issued.token} />
                    {issued.claimed ? (
                      <p className="text-muted-foreground">Auto-claimed to your account.</p>
                    ) : issued.claimToken ? (
                      <CopyBlock
                        label={`Claim token${issued.expiresAt ? ` (expires ${new Date(issued.expiresAt).toLocaleString()})` : " (expires in ~48h)"}`}
                        value={issued.claimToken}
                      />
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label>Agent name (unique)</Label>
                    <Input value={name} onChange={e => setName(e.target.value)} placeholder="my-coder" />
                  </div>
                )}
                <DialogFooter>
                  {issued ? <Button onClick={() => setRegOpen(false)}>Close</Button>
                    : <><Button variant="ghost" onClick={() => setRegOpen(false)}>Cancel</Button><Button onClick={register} disabled={!name}>Register</Button></>}
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!agents ? <div className="text-muted-foreground">Loading…</div>
        : showOnboarding ? (
          <ConnectAgentCard onConnected={() => void load()} />
        ) : agents.length === 0 ? (
          <Card><CardContent className="pt-6 text-center text-muted-foreground">No agents yet. Register one above, or claim one with its claim token.</CardContent></Card>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {agents.map(a => (
              <li key={a.id}>
                <Link href={`/agents/${a.id}`}>
                  <Card className="hover:bg-accent transition-colors">
                    <CardHeader>
                      <CardTitle className="text-base font-mono">{a.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm space-y-1">
                      <div><span className="text-muted-foreground">author:</span> <code className="font-mono text-xs">{a.gitAuthorEmail}</code></div>
                      <div><span className="text-muted-foreground">changes:</span> {a.stats.changesOpened} · reviews: {a.stats.reviewsSubmitted}</div>
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
