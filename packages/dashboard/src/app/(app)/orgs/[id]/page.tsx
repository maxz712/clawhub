"use client";

import { useEffect, useState, use } from "react";
import { api, type OrgRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus } from "lucide-react";

export default function OrgDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [org, setOrg] = useState<OrgRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  useEffect(() => {
    api.listOrgs()
      .then(r => setOrg(r.orgs.find(o => o.id === id) ?? null))
      .catch(e => setError((e as Error).message));
  }, [id]);

  async function addMember() {
    try { await api.addOrgMember(id, email, role); setEmail(""); setOpen(false); }
    catch (e) { setError((e as Error).message); }
  }

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!org) return <div className="text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-mono">{org.name}</h1>
        {org.displayName && <p className="text-muted-foreground mt-1">{org.displayName}</p>}
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Members</CardTitle>
          {org.role === "admin" && (
            <>
            <Button size="sm" variant="outline" className="gap-2" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> Add</Button>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent>
                <DialogHeader><DialogTitle>Add member</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <div><Label>Email</Label><Input type="email" value={email} onChange={e => setEmail(e.target.value)} /></div>
                  <div><Label>Role</Label>
                    <select className="w-full rounded border bg-background px-2 py-1.5" value={role} onChange={e => setRole(e.target.value as "admin" | "member")}>
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={addMember} disabled={!email}>Add</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            </>
          )}
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Member listing endpoint TBD. Use the add dialog to invite by email.
        </CardContent>
      </Card>
    </div>
  );
}
