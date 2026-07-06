"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type PlatformUsageSummary } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Gauge } from "lucide-react";

function usd(micro: number): string { return `$${(micro / 1_000_000).toFixed(2)}`; }

// Authoritative platform-key spend (M7) — the metered good, distinct from the
// self-reported BYO cost ledger. Month-to-date spend vs the tenant budget, with
// an inline budget editor (cap + on-exhaust behavior). `org` scopes to an org.
export function PlatformSpendCard({ org }: { org?: string }) {
  const [data, setData] = useState<PlatformUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [capUsd, setCapUsd] = useState("");
  const [onExhaust, setOnExhaust] = useState<"byo_fallback" | "queue" | "block">("byo_fallback");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api.platformUsage(org)); }
    catch (e) { setError((e as Error).message); }
  }, [org]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true); setError(null);
    try {
      await api.setPlatformBudget({ org, monthlyCapMicroUsd: Math.round(Number(capUsd || "0") * 1_000_000), onExhaust });
      setEditing(false);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }

  // Live Stripe (M7): upgrade to Pro (checkout) or manage the subscription (portal).
  async function upgrade() {
    setError(null);
    try { const { url } = await api.startCheckout({ org }); window.location.href = url; }
    catch (e) { setError(billingErr(e)); }
  }
  async function manageBilling() {
    setError(null);
    try { const { url } = await api.openBillingPortal({ org }); window.location.href = url; }
    catch (e) { setError(billingErr(e)); }
  }
  function billingErr(e: unknown): string {
    const m = (e as Error).message || "";
    return /stripe_not_configured/.test(m) ? "Billing isn't configured on this instance yet." : m;
  }

  if (!data) return null;
  const cap = data.budget.capMicroUsd;
  const pct = cap && cap > 0 ? Math.min(100, Math.round((data.spentMicroUsd / cap) * 100)) : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-primary" />
          <CardTitle className="text-sm">Platform spend</CardTitle>
          <Badge variant="secondary" className="uppercase text-[9px]">{data.plan}</Badge>
          <span className="ml-auto text-xs text-muted-foreground">metered · this month</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold">{usd(data.spentMicroUsd)}</span>
          {cap ? <span className="text-sm text-muted-foreground">of {usd(cap)} budget</span> : <span className="text-sm text-muted-foreground">no budget cap set</span>}
          {data.budget.alert && <Badge className="bg-amber-500/15 text-amber-300 border border-amber-400/30 uppercase text-[9px]">alert</Badge>}
          {data.budget.mode !== "proceed" && <Badge className="bg-destructive/15 text-destructive border border-destructive/30 uppercase text-[9px]">{data.budget.mode.replace("_", " ")}</Badge>}
        </div>
        {pct !== null && (
          <div className="h-2 w-full rounded bg-muted overflow-hidden">
            <div className={`h-full ${pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-400" : "bg-primary"}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Plan pool: {data.entitlements.platformReviews === Infinity ? "unlimited" : data.entitlements.platformReviews} reviews · {data.entitlements.verifyCredits === Infinity ? "unlimited" : data.entitlements.verifyCredits} verify credits / mo. Overage $0.10/review, $2.00/verify.
        </p>
        {editing ? (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Monthly cap (USD)</Label>
                <Input value={capUsd} onChange={e => setCapUsd(e.target.value)} placeholder="e.g. 200" inputMode="decimal" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">On exhaust</Label>
                <Select value={onExhaust} onValueChange={v => setOnExhaust(v as typeof onExhaust)}>
                  <SelectTrigger><SelectValue>{(v: string) => ({ byo_fallback: "Fall back to BYO key", queue: "Queue to next tick", block: "Block" }[v] ?? v)}</SelectValue></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="byo_fallback">Fall back to BYO key</SelectItem>
                    <SelectItem value="queue">Queue to next tick</SelectItem>
                    <SelectItem value="block">Block</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save budget"}</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => { setCapUsd(cap ? String(cap / 1_000_000) : ""); setEditing(true); }}>
              {cap ? "Edit budget" : "Set a budget"}
            </Button>
            {data.plan === "free"
              ? <Button size="sm" onClick={upgrade}>Upgrade to Pro</Button>
              : <Button variant="outline" size="sm" onClick={manageBilling}>Manage billing</Button>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
