"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function AdminPage() {
  const [stats, setStats] = useState<{ users: number; orgs: number; agents: number; repos: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; email: string; name: string | null; totpEnabled: boolean; createdAt: string }>>([]);
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string; displayName: string | null }>>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; associatedUserId: string | null; createdAt: string }>>([]);

  async function load() {
    try {
      const [s, u, o, a] = await Promise.all([api.adminStats(), api.adminListUsers(), api.adminListOrgs(), api.adminListAgents()]);
      setStats(s); setUsers(u.users); setOrgs(o.orgs); setAgents(a.agents);
    } catch (e) { setErr((e as Error).message); }
  }

  useEffect(() => { void load(); }, []);

  async function deleteUser(id: string) {
    if (!confirm(`Delete user ${id}?`)) return;
    try { await api.adminDeleteUser(id); void load(); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground">Platform-level governance. You must be listed in <code className="font-mono text-xs">CLAWHUB_ADMIN_EMAILS</code>.</p>
      </div>
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Users" value={stats.users} />
          <Stat label="Orgs" value={stats.orgs} />
          <Stat label="Agents" value={stats.agents} />
          <Stat label="Repos" value={stats.repos} />
        </div>
      )}

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="orgs">Orgs</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="export">Audit</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="space-y-2 pt-4">
          {users.map(u => (
            <Card key={u.id}><CardContent className="pt-4 flex items-center justify-between">
              <div>
                <div className="font-mono text-sm">{u.email}</div>
                <div className="text-xs text-muted-foreground">{u.name ?? "(no name)"} · 2FA: {u.totpEnabled ? "yes" : "no"} · {new Date(u.createdAt).toLocaleDateString()}</div>
              </div>
              <Button variant="destructive" size="sm" onClick={() => deleteUser(u.id)}>Delete</Button>
            </CardContent></Card>
          ))}
        </TabsContent>
        <TabsContent value="orgs" className="space-y-2 pt-4">
          {orgs.map(o => (
            <Card key={o.id}><CardContent className="pt-4"><div className="font-mono">{o.name}</div><div className="text-xs text-muted-foreground">{o.displayName}</div></CardContent></Card>
          ))}
        </TabsContent>
        <TabsContent value="agents" className="space-y-2 pt-4">
          {agents.map(a => (
            <Card key={a.id}><CardContent className="pt-4"><div className="font-mono">@{a.name}</div><div className="text-xs text-muted-foreground">{a.associatedUserId ? "claimed" : "unclaimed"} · {new Date(a.createdAt).toLocaleDateString()}</div></CardContent></Card>
          ))}
        </TabsContent>
        <TabsContent value="export" className="space-y-2 pt-4">
          <Card><CardHeader><CardTitle className="text-sm">Audit export</CardTitle></CardHeader>
            <CardContent>
              <a className="text-sm text-primary underline" href={api.adminAuditExportUrl(10000)} download="audit.ndjson">Download last 10k events (NDJSON)</a>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (<Card><CardContent className="pt-4"><div className="text-xs font-mono text-muted-foreground uppercase">{label}</div><div className="text-3xl font-bold text-primary">{value}</div></CardContent></Card>);
}
