"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2 } from "lucide-react";

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Org-wide cost budget: the cap on the org's agents' total monthly spend. The
 * column existed but gated nothing until Batch 7 — dispatch now enforces
 * min(agent cap, org cap). Admins edit; members see it read-only.
 */
export function OrgBudgetCard({ orgId, isAdmin }: { orgId: string; isAdmin: boolean }) {
  const [monthCents, setMonthCents] = useState(0);
  const [limitDollars, setLimitDollars] = useState("");
  const [hardLimit, setHardLimit] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.getOrgBudget(orgId);
      setMonthCents(r.monthCents);
      setLimitDollars(r.budget && r.budget.monthlyLimitCents > 0 ? (r.budget.monthlyLimitCents / 100).toFixed(2) : "");
      setHardLimit(r.budget ? r.budget.hardLimit : true);
    } catch (e) { setError((e as Error).message); }
    finally { setLoaded(true); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [orgId]);

  async function save() {
    setPending(true); setSaved(false); setError(null);
    try {
      const cents = Math.max(0, Math.round(Number(limitDollars) * 100) || 0);
      await api.setOrgBudget(orgId, { monthlyLimitCents: cents, hardLimit });
      setSaved(true);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  if (!loaded) return null;
  const limitCents = Math.round(Number(limitDollars) * 100) || 0;
  const pct = limitCents > 0 ? Math.round((monthCents / limitCents) * 100) : 0;

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Org cost budget</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {error && <Alert variant="destructive"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}
        <div className="text-sm">
          This month: <span className="font-mono">{dollars(monthCents)}</span>
          {limitCents > 0 && <span className="text-muted-foreground"> / {dollars(limitCents)} ({pct}%)</span>}
        </div>
        {isAdmin ? (
          <>
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <Label className="text-xs">Monthly limit (USD, 0 = unlimited)</Label>
                <Input type="number" min={0} step="0.01" value={limitDollars} onChange={e => { setLimitDollars(e.target.value); setSaved(false); }} className="w-40" placeholder="0.00" />
              </div>
              <label className="flex items-center gap-2 text-sm pb-2">
                <input type="checkbox" checked={hardLimit} onChange={e => { setHardLimit(e.target.checked); setSaved(false); }} className="accent-primary" />
                Hard limit (block dispatch over budget)
              </label>
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => void save()} disabled={pending}>{pending ? "Saving…" : "Save budget"}</Button>
              {saved && <span className="flex items-center gap-1 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" /> Saved</span>}
            </div>
            <p className="text-xs text-muted-foreground">Caps monthly spend <strong>on this org&apos;s repos</strong>. A dispatch for an org repo is blocked when the org hard limit is exceeded — alongside each agent&apos;s own cap (the tighter wins).</p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{limitCents > 0 ? `Hard limit ${hardLimit ? "on" : "off"}.` : "No org budget set."} Only org admins can change it.</p>
        )}
      </CardContent>
    </Card>
  );
}
