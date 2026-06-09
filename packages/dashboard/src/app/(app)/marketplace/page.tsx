"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function MarketplacePage() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.marketplaceList>>["agents"]>([]);
  async function load() { setItems((await api.marketplaceList(q || undefined)).agents); }
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-mono">Agent marketplace</h1>
        <p className="text-sm text-muted-foreground">Curated reviewer, security, and perf agents. Install one into an org or repo with one click.</p>
      </div>
      <Input placeholder="Search agents…" value={q} onChange={e => setQ(e.target.value)} className="max-w-md" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.map(a => (
          <Card key={a.slug}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <span className="font-mono">{a.name}</span>
                {a.verified && <Badge>verified</Badge>}
                <Badge variant="outline">{a.pricingModel}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">{a.installs} installs</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {a.tagline && <p className="text-sm">{a.tagline}</p>}
              <div className="flex gap-1 flex-wrap">{a.capabilities.map(c => <Badge key={c} variant="secondary" className="text-[10px]">{c}</Badge>)}</div>
              <Button size="sm" variant="outline" onClick={async () => { await api.marketplaceInstall(a.slug); void load(); }}>Install</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
