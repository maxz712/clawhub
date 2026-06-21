"use client";

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { api, type OrgRow, type OrgMember, type Repo } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Bot, ShieldCheck, Boxes, KeyRound, CheckCircle2, Trash2, Users, GitBranch } from "lucide-react";

export default function OrgDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [org, setOrg] = useState<OrgRow | null>(null);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [reposErr, setReposErr] = useState<string | null>(null);
  // Distinguish "still loading" from "loaded but failed/forbidden" so we never
  // spin forever: orgLoaded flips true once the list resolves.
  const [orgLoaded, setOrgLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [membersErr, setMembersErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const isAdmin = org?.role === "admin";

  const loadMembers = useCallback(async () => {
    setMembersErr(null);
    try { const r = await api.listOrgMembers(id); setMembers(r.members); }
    catch (e) { setMembers([]); setMembersErr((e as Error).message); }
  }, [id]);

  // Org repos rollup: listRepos is already scoped to repos the caller can see,
  // so filtering to this org's namespace can't leak anything. We don't have a
  // per-repo open-change-count endpoint, so we surface last activity (updatedAt)
  // from the same payload instead.
  const loadRepos = useCallback(async () => {
    setReposErr(null);
    try {
      const r = await api.listRepos();
      setRepos(r.repos.filter(x => x.namespaceType === "org" && x.namespaceId === id));
    } catch (e) { setRepos([]); setReposErr((e as Error).message); }
  }, [id]);

  useEffect(() => {
    api.listOrgs()
      .then(r => { setOrg(r.orgs.find(o => o.id === id) ?? null); })
      .catch(e => setError((e as Error).message))
      .finally(() => setOrgLoaded(true));
  }, [id]);

  // Only fetch members + repos once we know the org is visible to the caller.
  useEffect(() => { if (org) { void loadMembers(); void loadRepos(); } }, [org, loadMembers, loadRepos]);

  async function addMember() {
    setError(null); setAdded(null); setAdding(true);
    try {
      await api.addOrgMember(id, email, role);
      setAdded(email);
      setEmail(""); setRole("member"); setOpen(false);
      await loadMembers();
    } catch (e) { setError((e as Error).message); }
    finally { setAdding(false); }
  }

  async function changeRole(m: OrgMember, next: "admin" | "member") {
    if (next === m.role) return;
    setError(null); setBusy(m.userId);
    try { await api.patchOrgMemberRole(id, m.userId, next); await loadMembers(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function remove(m: OrgMember) {
    setError(null); setBusy(m.userId);
    try { await api.removeOrgMember(id, m.userId); await loadMembers(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  // Resolved the org list but this id isn't in it → not a member / not found.
  if (orgLoaded && !org) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Organization not found, or you don&apos;t have access to it.</AlertDescription>
      </Alert>
    );
  }
  if (!org) return <div className="text-muted-foreground">Loading…</div>;

  const hubLinks: Array<{ href: string; label: string; icon: React.ReactNode }> = [
    { href: `/orgs/${org.id}/fleet`, label: "Fleet", icon: <Bot className="h-4 w-4" /> },
    { href: `/orgs/${org.id}/sso`, label: "SSO", icon: <KeyRound className="h-4 w-4" /> },
    { href: `/orgs/${org.id}/registry`, label: "Agent registry", icon: <Boxes className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{org.name}</h1>
          {org.displayName && <p className="text-muted-foreground mt-1">{org.displayName}</p>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {hubLinks.map(l => (
          <a key={l.href} href={l.href}>
            <Button variant="outline" size="sm" className="gap-2">{l.icon} {l.label}</Button>
          </a>
        ))}
      </div>

      {added && (
        <Alert>
          <AlertDescription className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-primary" /> Added <code className="font-mono">{added}</code> to the org.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2"><GitBranch className="h-4 w-4 text-muted-foreground" /> Repositories</CardTitle>
        </CardHeader>
        <CardContent>
          {reposErr
            ? <Alert variant="destructive"><AlertDescription>{reposErr}</AlertDescription></Alert>
            : repos === null
              ? <div className="text-sm text-muted-foreground">Loading repos…</div>
              : repos.length === 0
                ? <div className="text-sm text-muted-foreground">No repos under this org yet. An agent&apos;s first push to <code className="font-mono">{org.name}/&lt;repo&gt;</code> creates one.</div>
                : (
                  <ul className="divide-y divide-border">
                    {repos.map(r => {
                      const ns = r.namespaceName ?? org.name;
                      return (
                        <li key={r.id} className="py-2.5 first:pt-0 last:pb-0">
                          <Link href={`/repos/${ns}/${r.name}`} className="flex items-center justify-between gap-3 hover:opacity-80 transition-opacity">
                            <div className="flex items-center gap-2 min-w-0">
                              <code className="font-mono text-sm truncate">{ns}/{r.name}</code>
                              {r.isPublic ? <Badge variant="secondary" className="text-[10px]">public</Badge> : <Badge variant="outline" className="text-[10px]">private</Badge>}
                            </div>
                            <span className="text-xs text-muted-foreground shrink-0">updated {new Date(r.updatedAt).toLocaleDateString()}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Members</CardTitle>
          {isAdmin && (
            <>
            <Button size="sm" variant="outline" className="gap-2" onClick={() => { setAdded(null); setOpen(true); }}><Plus className="h-3.5 w-3.5" /> Add</Button>
            <Dialog open={open} onOpenChange={v => { setOpen(v); if (!v) { setEmail(""); setRole("member"); } }}>
              <DialogContent>
                <DialogHeader><DialogTitle>Add member</DialogTitle></DialogHeader>
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <div className="space-y-3">
                  <div>
                    <Label>Email</Label>
                    <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="teammate@example.com" />
                    <p className="mt-1 text-xs text-muted-foreground">Must already have a ClawHub account.</p>
                  </div>
                  <div>
                    <Label>Role</Label>
                    <Select value={role} onValueChange={v => setRole(v as "admin" | "member")}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member"><span className="flex items-center gap-2"><Users className="h-3.5 w-3.5" /> member</span></SelectItem>
                        <SelectItem value="admin"><span className="flex items-center gap-2"><ShieldCheck className="h-3.5 w-3.5" /> admin</span></SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-xs text-muted-foreground">Admins can manage members, SSO, and the fleet.</p>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={addMember} disabled={!email || adding}>{adding ? "Adding…" : "Add"}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            </>
          )}
        </CardHeader>
        <CardContent>
          {membersErr
            ? <Alert variant="destructive"><AlertDescription>{membersErr}</AlertDescription></Alert>
            : members === null
              ? <div className="text-sm text-muted-foreground">Loading members…</div>
              : members.length === 0
                ? <div className="text-sm text-muted-foreground">No members yet.{isAdmin ? " Use Add to invite by email." : ""}</div>
                : (
                  <ul className="divide-y divide-border">
                    {members.map(m => (
                      <li key={m.userId} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{m.name || m.email}</div>
                          {m.name && <div className="text-xs text-muted-foreground truncate">{m.email}</div>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {isAdmin
                            ? (
                              <Select value={m.role} onValueChange={v => void changeRole(m, v as "admin" | "member")} disabled={busy === m.userId}>
                                <SelectTrigger className="w-28 h-8"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="member"><span className="flex items-center gap-2"><Users className="h-3.5 w-3.5" /> member</span></SelectItem>
                                  <SelectItem value="admin"><span className="flex items-center gap-2"><ShieldCheck className="h-3.5 w-3.5" /> admin</span></SelectItem>
                                </SelectContent>
                              </Select>
                            )
                            : <span className="text-xs uppercase tracking-wide text-muted-foreground">{m.role}</span>}
                          {isAdmin && (
                            <Button variant="ghost" size="sm" disabled={busy === m.userId} onClick={() => void remove(m)} aria-label="Remove member">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
        </CardContent>
      </Card>
    </div>
  );
}
