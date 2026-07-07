"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type OrgRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronRight, Wallet } from "lucide-react";
import { PlatformSpendCard } from "@/components/platform-spend-card";

interface Row { agentId: string; name: string; costCents: number; inputTokens: number; outputTokens: number }

function fmtUsd(cents: number): string { return `$${(cents / 100).toFixed(2)}`; }

export default function CostPage() {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [orgId, setOrgId] = useState<string>("");          // "" → caller's governed agents (no org)
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [budgetFor, setBudgetFor] = useState<Row | null>(null);

  const load = useCallback(async (scopeOrgId: string) => {
    setLoading(true); setError(null);
    try {
      // Name resolution: the org fleet snapshot (membership-authz'd server-side)
      // carries agent names keyed by id; the caller's own agents fill any gaps.
      const [board, mine, fleet] = await Promise.all([
        // Scope the leaderboard to the selected org's repos when chosen — never a
        // global all-tenant board.
        api.costLeaderboard(scopeOrgId ? { orgId: scopeOrgId, limit: 100 } : { limit: 100 }),
        api.listAgents().catch(() => ({ agents: [] as Array<{ id: string; name: string }> })),
        scopeOrgId ? api.getOrgFleet(scopeOrgId).catch(() => null) : Promise.resolve(null),
      ]);
      const names = new Map<string, string>();
      for (const a of mine.agents) names.set(a.id, a.name);
      if (fleet) for (const a of fleet.agents) names.set(a.agentId, a.name);

      let board2 = board.leaderboard;
      // No org chosen and no global entries surfaced: fall back to the caller's
      // own governed agents so a solo manager still sees their spend (instead of
      // an empty global board they can't act on).
      if (!scopeOrgId && board2.length === 0 && mine.agents.length) {
        const perAgent = await Promise.all(mine.agents.map(async a => {
          const c = await api.agentCost(a.id).catch(() => ({ monthCents: 0 }));
          return { agentId: a.id, costCents: c.monthCents, inputTokens: 0, outputTokens: 0 };
        }));
        board2 = perAgent.filter(r => r.costCents > 0);
      }
      setRows(board2.map(r => ({ ...r, name: names.get(r.agentId) ?? r.agentId })));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void (async () => {
      const o = await api.listOrgs().catch(() => ({ orgs: [] as OrgRow[] }));
      setOrgs(o.orgs);
      const first = o.orgs[0]?.id ?? "";
      setOrgId(first);
      await load(first);
    })();
  }, [load]);

  function onScopeChange(v: string) { setOrgId(v); void load(v); }

  const total = rows.reduce((a, r) => a + r.costCents, 0);
  const totalTokens = rows.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cost</h1>
          <p className="text-sm text-muted-foreground">Two ledgers: <strong>metered platform spend</strong> (authoritative — ClawHub&apos;s own key powering advisory review + verify, billed) and <strong>self-reported BYO-LLM spend</strong> (each agent reports its own token + dollar cost from <em>your</em> provider key). Set budgets to cap or alert.</p>
        </div>
        {orgs.length > 0 ? (
          <div className="min-w-44">
            <Label className="text-xs text-muted-foreground">Scope</Label>
            <Select value={orgId || "__mine"} onValueChange={v => onScopeChange(v === "__mine" ? "" : (v ?? ""))}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__mine">My agents</SelectItem>
                {orgs.map(o => <SelectItem key={o.id} value={o.id}>{o.displayName || o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground shrink-0">Scope: <span className="text-foreground">My agents</span></div>
        )}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {/* Authoritative platform-key spend (M7) — the metered good. */}
      <PlatformSpendCard org={orgId || undefined} />

      <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider pt-1">Self-reported BYO spend</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card><CardContent className="pt-6">
          <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">This month total <span className="font-normal normal-case">(self-reported)</span></div>
          <div className="text-4xl font-bold text-primary mt-1">{loading ? "—" : fmtUsd(total)}</div>
          <div className="text-xs text-muted-foreground font-mono mt-1">{loading ? "" : `${totalTokens.toLocaleString()} tokens`}</div>
        </CardContent></Card>
        <Card><CardContent className="pt-6">
          <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Agents reporting spend</div>
          <div className="text-4xl font-bold text-blue-400 mt-1">{loading ? "—" : rows.length}</div>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Top spenders</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2 py-2">
              {[0, 1, 2, 3].map(i => <div key={i} className="h-6 rounded bg-muted/40 animate-pulse" />)}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground space-y-2">
              <p>No spend reported yet — figures appear once a standing agent runs and reports its token + dollar cost.</p>
              {orgId
                ? <Link href={`/orgs/${orgId}/fleet`} className={buttonVariants({ size: "sm", variant: "outline" })}>Open the fleet</Link>
                : <Link href="/agents/workflows" className={buttonVariants({ size: "sm", variant: "outline" })}>Give agents work in Workflows</Link>}
            </div>
          ) : (
            <div className="divide-y divide-border text-sm">
              {rows.map((r, i) => (
                <div key={r.agentId} className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 py-2">
                  <span className="w-8 text-right text-muted-foreground font-mono">#{i + 1}</span>
                  <Link href={`/agents/${r.agentId}?tab=cost`} className="truncate font-medium hover:text-primary flex items-center gap-1">
                    {r.name}<ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </Link>
                  <Badge variant="outline" className="font-mono">{(r.inputTokens + r.outputTokens).toLocaleString()} tok</Badge>
                  <span className="font-bold text-primary font-mono">{fmtUsd(r.costCents)}</span>
                  <Button variant="ghost" size="sm" className="gap-1.5" title="Set budget" onClick={() => setBudgetFor(r)}>
                    <Wallet className="h-3.5 w-3.5" /> budget
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <BudgetDialog row={budgetFor} onClose={() => setBudgetFor(null)} onSaved={() => load(orgId)} />
    </div>
  );
}

function BudgetDialog({ row, onClose, onSaved }: { row: Row | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [limitDollars, setLimitDollars] = useState("");
  const [hardLimit, setHardLimit] = useState(false);
  const [alertPercent, setAlertPercent] = useState("80");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setLimitDollars(""); setHardLimit(false); setAlertPercent("80"); setErr(null); }, [row]);
  if (!row) return null;

  async function save() {
    const dollars = Number(limitDollars);
    if (!Number.isFinite(dollars) || dollars <= 0) { setErr("Enter a monthly limit in dollars."); return; }
    const pct = Math.min(Math.max(Number(alertPercent) || 80, 1), 100);
    setBusy(true); setErr(null);
    try {
      await api.setAgentBudget(row!.agentId, { monthlyLimitCents: Math.round(dollars * 100), hardLimit, alertAtPercent: pct });
      onClose(); await onSaved();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const limitCents = Math.round((Number(limitDollars) || 0) * 100);
  return (
    <Dialog open={!!row} onOpenChange={v => { if (!v && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Budget for “{row.name}”</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Current spend this month: <span className="font-mono text-foreground">{fmtUsd(row.costCents)}</span></p>
          {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
          <div>
            <Label>Monthly limit (USD)</Label>
            <Input inputMode="decimal" value={limitDollars} onChange={e => setLimitDollars(e.target.value)} placeholder="e.g. 50" />
            {limitCents > 0 && (() => {
              const pct = Math.round((row.costCents / limitCents) * 100);
              const over = pct >= 100;
              return <p className={`text-xs mt-1 ${over ? "text-destructive" : "text-muted-foreground"}`}>{fmtUsd(row.costCents)} spent of {fmtUsd(limitCents)} ({pct}%{over ? " — already over limit" : ""})</p>;
            })()}
          </div>
          <div>
            <Label>Enforcement</Label>
            <Select value={hardLimit ? "hard" : "alert"} onValueChange={v => setHardLimit(v === "hard")}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="alert">Alert only — warn, don&apos;t block</SelectItem>
                <SelectItem value="hard">Enforce — block spend over the limit</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Alert at %</Label>
            <Input type="number" min={1} max={100} value={alertPercent} onChange={e => setAlertPercent(e.target.value)} placeholder="80" />
            {(() => { const n = Number(alertPercent); return alertPercent !== "" && (!Number.isFinite(n) || n < 1 || n > 100)
              ? <p className="text-xs text-destructive mt-1">Enter a percentage between 1 and 100.</p> : null; })()}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save budget"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
