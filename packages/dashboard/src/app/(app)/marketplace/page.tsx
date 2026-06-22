"use client";

import { useEffect, useState } from "react";
import { api, type OrgRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type MarketplaceItem = Awaited<ReturnType<typeof api.marketplaceList>>["agents"][number];

const PERSONAL = "__personal__";

export default function MarketplacePage() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Per-slug install state: "busy" while in flight, then "done" / an error message.
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [installed, setInstalled] = useState<Record<string, string>>({}); // slug -> "ok" | error
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  // The install dialog: which agent is being installed + the chosen target.
  const [target, setTarget] = useState<MarketplaceItem | null>(null);
  const [targetOrg, setTargetOrg] = useState<string>(PERSONAL);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.marketplaceList(q || undefined);
      setItems(r.agents);
    } catch (e) { setErr((e as Error).message); setItems([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q]);
  useEffect(() => { api.listOrgs().then(r => setOrgs(r.orgs)).catch(() => setOrgs([])); }, []);

  async function confirmInstall() {
    if (!target) return;
    const slug = target.slug;
    const orgId = targetOrg === PERSONAL ? undefined : targetOrg;
    setTarget(null);
    setInstalling(s => ({ ...s, [slug]: true }));
    setInstalled(s => { const n = { ...s }; delete n[slug]; return n; });
    try {
      await api.marketplaceInstall(slug, orgId ? { orgId } : {});
      setInstalled(s => ({ ...s, [slug]: "ok" }));
      await load();
    } catch (e) {
      setInstalled(s => ({ ...s, [slug]: (e as Error).message || "Install failed" }));
    } finally {
      setInstalling(s => ({ ...s, [slug]: false }));
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Agent marketplace</h1>
        <p className="text-sm text-muted-foreground">Curated reviewer, security, and perf agents. Install one to add it to your account.</p>
      </div>
      <Input placeholder="Search agents…" value={q} onChange={e => setQ(e.target.value)} className="max-w-md" />

      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[0, 1, 2, 3].map(i => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="pb-2"><div className="h-4 w-40 bg-muted rounded" /></CardHeader>
              <CardContent className="space-y-2">
                <div className="h-3 w-full bg-muted rounded" />
                <div className="h-3 w-2/3 bg-muted rounded" />
                <div className="h-7 w-20 bg-muted rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground text-center">
            {q ? `No agents match "${q}".` : "No agents published yet."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map(a => {
            const busy = installing[a.slug];
            const result = installed[a.slug];
            return (
              <Card key={a.slug}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <span className="font-mono">{a.name}</span>
                    <Badge variant="outline">{a.pricingModel}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{a.installs} installs</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {a.tagline && <p className="text-sm">{a.tagline}</p>}
                  <div className="flex gap-1 flex-wrap">{a.capabilities.map(c => <Badge key={c} variant="secondary" className="text-[10px]">{c}</Badge>)}</div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => { setTarget(a); setTargetOrg(PERSONAL); }}>
                      {busy ? "Installing…" : result === "ok" ? "Installed" : "Install"}
                    </Button>
                    {result === "ok" && <span className="text-xs text-primary">Installed</span>}
                    {result && result !== "ok" && <span className="text-xs text-destructive">{result}</span>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!target} onOpenChange={v => { if (!v) setTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Install {target?.name}</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Choose where to install this agent.</p>
            <Select value={targetOrg} onValueChange={v => setTargetOrg(v ?? PERSONAL)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={PERSONAL}>Personal account</SelectItem>
                {orgs.map(o => <SelectItem key={o.id} value={o.id}>{o.displayName || o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)}>Cancel</Button>
            <Button onClick={() => void confirmInstall()}>Install</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
