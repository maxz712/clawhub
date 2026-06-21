"use client";

import { use, useEffect, useState } from "react";
import { api, type Agent, type RegisteredOrgAgent } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function OrgRegistryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rows, setRows] = useState<RegisteredOrgAgent[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    const [reg, all] = await Promise.all([
      api.listOrgRegistry(id).catch(() => ({ agents: [] as RegisteredOrgAgent[] })),
      api.listAgents().catch(() => ({ agents: [] as Agent[] })),
    ]);
    setRows(reg.agents);
    setAgents(all.agents);
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  // Agents not already enrolled — the picker only offers fresh candidates.
  const enrolledIds = new Set(rows.map(r => r.agentId));
  const candidates = agents.filter(a => !enrolledIds.has(a.id));

  async function enroll() {
    if (!agentId) return;
    setBusy(true); setErr(null);
    try {
      await api.enrollOrgAgent(id, agentId, "sandbox");
      setAgentId("");
      await load();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Agent registry</h1>
        <p className="text-sm text-muted-foreground">
          Org-curated list of agents and their trust tier. The trust tier is a real merge lever for this
          org&rsquo;s repos: <span className="font-mono">trusted</span> agents&rsquo; reviews count toward
          approvals on low-risk changes (like a per-repo trusted-agent), and a tier below{" "}
          <span className="font-mono">standard</span> withholds earned-autonomy self-merge. Sensitive-path,
          medium+, and high-risk gates always still require a human.
        </p>
      </div>

      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      <Card>
        <CardHeader><CardTitle className="text-sm">Enroll agent</CardTitle></CardHeader>
        <CardContent className="flex gap-2 items-center">
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No agents available to enroll. Register an agent first, then return here.
            </p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every visible agent is already enrolled.</p>
          ) : (
            <>
              <Select value={agentId} onValueChange={v => setAgentId(v ?? "")}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Select an agent…" /></SelectTrigger>
                <SelectContent>
                  {candidates.map(a => (
                    <SelectItem key={a.id} value={a.id}>@{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={enroll} disabled={busy || !agentId}>{busy ? "Enrolling…" : "Enroll (sandbox tier)"}</Button>
            </>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        {rows.length === 0 && (
          <Card>
            <CardContent className="pt-6 text-sm text-muted-foreground text-center">
              No agents enrolled yet. Enroll one above to start governing it at the org level.
            </CardContent>
          </Card>
        )}
        {rows.map(r => (
          <Card key={r.id}>
            <CardContent className="pt-4 flex items-center justify-between">
              <div>
                <div className="font-mono font-semibold">@{r.name}</div>
                <div className="text-xs font-mono text-muted-foreground">{r.gitAuthorEmail}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={r.trustTier === "trusted" ? "default" : r.trustTier === "standard" ? "secondary" : "outline"}>{r.trustTier}</Badge>
                {(["sandbox", "standard", "trusted"] as const).map(t => (
                  <Button key={t} size="sm" variant="outline" disabled={r.trustTier === t} onClick={async () => { try { await api.enrollOrgAgent(id, r.agentId, t); await load(); } catch (e) { setErr((e as Error).message); } }}>{t}</Button>
                ))}
                <Button size="sm" variant="destructive" onClick={async () => { try { await api.revokeOrgAgent(id, r.agentId); await load(); } catch (e) { setErr((e as Error).message); } }}>Revoke</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
