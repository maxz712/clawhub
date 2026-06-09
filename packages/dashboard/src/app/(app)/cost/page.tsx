"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Row { agentId: string; costCents: number; inputTokens: number; outputTokens: number }

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function CostPage() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { void api.costLeaderboard({ limit: 100 }).then(r => setRows(r.leaderboard)); }, []);
  const total = rows.reduce((a, r) => a + r.costCents, 0);
  const totalTokens = rows.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-mono">Cost</h1>
        <p className="text-sm text-muted-foreground">Agent token + $ spend this month. Agents self-report via the cost ledger endpoint.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card><CardContent className="pt-6">
          <div className="text-xs text-muted-foreground font-mono uppercase">This month total</div>
          <div className="text-4xl font-bold text-primary mt-1">{fmtUsd(total)}</div>
          <div className="text-xs text-muted-foreground font-mono mt-1">{totalTokens.toLocaleString()} tokens</div>
        </CardContent></Card>
        <Card><CardContent className="pt-6">
          <div className="text-xs text-muted-foreground font-mono uppercase">Agents billing</div>
          <div className="text-4xl font-bold text-blue-400 mt-1">{rows.length}</div>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Top spenders</CardTitle></CardHeader>
        <CardContent>
          <div className="divide-y divide-border font-mono text-sm">
            {rows.length === 0 && <div className="text-muted-foreground py-4">No cost entries yet. Agents record via POST /api/v1/cost/self.</div>}
            {rows.map((r, i) => (
              <div key={r.agentId} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 py-2">
                <span className="w-8 text-right text-muted-foreground">#{i + 1}</span>
                <span className="truncate">{r.agentId}</span>
                <Badge variant="outline">{(r.inputTokens + r.outputTokens).toLocaleString()} tok</Badge>
                <span className="font-bold text-primary">{fmtUsd(r.costCents)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
