"use client";

import { use, useEffect, useState } from "react";
import { api, type RegisteredOrgAgent } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export default function OrgRegistryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rows, setRows] = useState<RegisteredOrgAgent[]>([]);
  const [agentId, setAgentId] = useState("");

  async function load() { const r = await api.listOrgRegistry(id); setRows(r.agents); }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function enroll() { if (!agentId) return; await api.enrollOrgAgent(id, agentId, "sandbox"); setAgentId(""); void load(); }

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Agent registry</h1>
        <p className="text-sm text-muted-foreground">Org-curated list of agents and their trust tier. Merge policies can key off this list.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Enroll agent</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          <Input placeholder="agent uuid" value={agentId} onChange={e => setAgentId(e.target.value)} />
          <Button onClick={enroll}>Enroll (sandbox tier)</Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
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
                  <Button key={t} size="sm" variant="outline" disabled={r.trustTier === t} onClick={async () => { await api.enrollOrgAgent(id, r.agentId, t); void load(); }}>{t}</Button>
                ))}
                <Button size="sm" variant="destructive" onClick={async () => { await api.revokeOrgAgent(id, r.agentId); void load(); }}>Revoke</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
