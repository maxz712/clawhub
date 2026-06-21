"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

type MarketplaceItem = Awaited<ReturnType<typeof api.marketplaceList>>["agents"][number];

export default function MarketplacePage() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Per-slug install state: "busy" while in flight, then "done" / an error message.
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [installed, setInstalled] = useState<Record<string, string>>({}); // slug -> "ok" | error

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.marketplaceList(q || undefined);
      setItems(r.agents);
    } catch (e) { setErr((e as Error).message); setItems([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q]);

  async function install(slug: string) {
    setInstalling(s => ({ ...s, [slug]: true }));
    setInstalled(s => { const n = { ...s }; delete n[slug]; return n; });
    try {
      // Installs the agent for the caller (server resolves the target). With no
      // org/repo it records the install against the current account.
      await api.marketplaceInstall(slug);
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
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => install(a.slug)}>
                      {busy ? "Installing…" : result === "ok" ? "Installed" : "Install"}
                    </Button>
                    {result === "ok" && <span className="text-xs text-primary">Added to your account</span>}
                    {result && result !== "ok" && <span className="text-xs text-destructive">{result}</span>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
