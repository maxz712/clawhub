"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type OrgRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus } from "lucide-react";

export default function OrgsPage() {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");

  async function load() { setOrgs((await api.listOrgs()).orgs); }
  useEffect(() => { load().catch(e => setError((e as Error).message)); }, []);

  async function create() {
    try { await api.createOrg(name, displayName || undefined); setName(""); setDisplayName(""); setOpen(false); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Organizations</h1>
        <Button size="sm" className="gap-2" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New org</Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Create organization</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Name (unique, URL slug)</Label><Input value={name} onChange={e => setName(e.target.value)} /></div>
              <div><Label>Display name</Label><Input value={displayName} onChange={e => setDisplayName(e.target.value)} /></div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={create} disabled={!name}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!orgs ? <div className="text-muted-foreground">Loading…</div>
        : orgs.length === 0 ? (
          <Card><CardContent className="pt-6 text-center text-muted-foreground">No orgs yet.</CardContent></Card>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {orgs.map(o => (
              <li key={o.id}>
                <Link href={`/orgs/${o.id}`}>
                  <Card className="hover:bg-accent transition-colors">
                    <CardHeader>
                      <CardTitle className="text-base font-mono flex items-center gap-2">{o.name}<Badge variant="outline" className="text-[10px]">{o.role}</Badge></CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">{o.displayName}</CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
