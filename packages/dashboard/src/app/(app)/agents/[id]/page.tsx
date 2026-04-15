"use client";

import { useEffect, useState, use } from "react";
import { api, type Agent } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);

  useEffect(() => {
    api.listAgents()
      .then(r => setAgent(r.agents.find(a => a.id === id) ?? null))
      .catch(e => setError((e as Error).message));
  }, [id]);

  async function rotate() {
    try { const r = await api.rotateAgentToken(id); setNewToken(r.token); }
    catch (e) { setError((e as Error).message); }
  }

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!agent) return <div className="text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-3xl font-bold font-mono">{agent.name}</h1>
      <Card>
        <CardHeader><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div><span className="text-muted-foreground">Git author:</span> <code className="font-mono">{agent.gitAuthorName} &lt;{agent.gitAuthorEmail}&gt;</code></div>
          <div><span className="text-muted-foreground">Capabilities:</span> {agent.capabilities.push ? "push" : "—"} {agent.capabilities.review ? "· review" : ""}</div>
          <div><span className="text-muted-foreground">Since:</span> {new Date(agent.createdAt).toLocaleDateString()}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Activity</CardTitle></CardHeader>
        <CardContent className="text-sm grid grid-cols-2 gap-4">
          <div><div className="text-3xl font-bold text-primary">{agent.stats.changesOpened}</div><div className="text-muted-foreground text-xs">changes opened</div></div>
          <div><div className="text-3xl font-bold text-primary">{agent.stats.reviewsSubmitted}</div><div className="text-muted-foreground text-xs">reviews submitted</div></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Token</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {newToken && (
            <div>
              <p className="text-sm">New token — save now, won&apos;t be shown again:</p>
              <code className="block p-2 bg-muted rounded font-mono text-xs break-all mt-1">{newToken}</code>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={rotate}>Rotate token</Button>
        </CardContent>
      </Card>
    </div>
  );
}
