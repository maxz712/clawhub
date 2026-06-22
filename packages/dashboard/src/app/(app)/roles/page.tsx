"use client";

import { useEffect, useState } from "react";
import { api, type AgentRoleRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CustomRoleDialog } from "@/components/custom-role-dialog";
import { Bot, Shield, Boxes, Sparkles, Zap, Plus, Trash2, CheckCircle2, Rocket } from "lucide-react";

const CAP_ICON: Record<string, typeof Bot> = { worker: Bot, reviewer: Shield, triager: Boxes, specialist: Sparkles };

const AUTONOMY_NOTE =
  "Earned autonomy lets a role self-merge ONLY its own LOW-risk work, and only after it has a track record + clears the quality bar. It never bypasses sensitive-path, medium+/high-risk, or human-required gates.";

export default function RolesPage() {
  const [roles, setRoles] = useState<AgentRoleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [deploy, setDeploy] = useState<AgentRoleRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AgentRoleRow | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { const r = await api.listRoles(); setRoles(r.roles); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  function flash(msg: string) { setNotice(msg); setError(null); }

  async function doDelete() {
    if (!confirmDelete) return;
    setBusy(true); setError(null);
    try { await api.deleteRole(confirmDelete.id); flash(`Deleted role “${confirmDelete.name}”.`); setConfirmDelete(null); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Roles</h1>
          <p className="text-muted-foreground mt-1">Your personal agent roles — reusable templates you deploy to any repo you can write.</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { setNotice(null); setCustomOpen(true); }}><Plus className="h-4 w-4" /> Create custom role</Button>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && (
        <Alert className="border-primary/30">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          <AlertDescription className="text-foreground">{notice}</AlertDescription>
        </Alert>
      )}

      {!roles ? <div className="text-muted-foreground">Loading…</div>
        : roles.length === 0 ? (
          <Card><CardContent className="pt-6 text-center text-muted-foreground">No personal roles yet. Create one to define a reusable agent you can deploy to your repos.</CardContent></Card>
        ) : (
          <div className="space-y-2">
            {roles.map(r => {
              const Icon = CAP_ICON[r.capability] ?? Bot;
              return (
                <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon className="h-4 w-4 text-primary shrink-0" />
                    <Badge className="bg-primary/15 text-primary border border-primary/30">{r.capability}</Badge>
                    <span className="font-medium truncate">{r.name}</span>
                    {r.specialization && <Badge variant="outline" className="text-[10px]">{r.specialization}</Badge>}
                    {r.earnedAutonomy && <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30 text-[10px]" title={AUTONOMY_NOTE}><Zap className="h-3 w-3" /> autonomy</Badge>}
                    <span className="text-xs text-muted-foreground">· {r.deployments ?? 0} deployment(s)</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="outline" size="sm" className="gap-2" disabled={busy} onClick={() => { setNotice(null); setDeploy(r); }}><Rocket className="h-4 w-4" /> Deploy</Button>
                    <Button variant="ghost" size="sm" title="Delete role" disabled={busy} onClick={() => { setNotice(null); setConfirmDelete(r); }}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      <CustomRoleDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        onError={setError}
        onCreated={async name => { flash(`Created role “${name}”.`); await load(); }}
      />

      <DeployRoleDialog role={deploy} onClose={() => setDeploy(null)} onDeployed={load} onError={setError} onNotice={flash} />

      {/* Confirm delete */}
      <Dialog open={!!confirmDelete} onOpenChange={v => { if (!v && !busy) setConfirmDelete(null); }}>
        <DialogContent>
          {confirmDelete && (
            <>
              <DialogHeader><DialogTitle>Delete role “{confirmDelete.name}”?</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">Permanently removes this role. Existing deployments are removed first. This cannot be undone.</p>
              <DialogFooter>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</Button>
                <Button variant="destructive" disabled={busy} onClick={doDelete}>{busy ? "Working…" : "Delete role"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeployRoleDialog({ role, onClose, onDeployed, onError, onNotice }: {
  role: AgentRoleRow | null;
  onClose: () => void;
  onDeployed: () => Promise<void>;
  onError: (s: string) => void;
  onNotice: (s: string) => void;
}) {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRepo(""); }, [role]);
  if (!role) return null;

  async function go() {
    const target = repo.trim();
    if (!target.includes("/")) { onError("Repo must be ns/name (e.g. acme/api)."); return; }
    setBusy(true);
    try {
      await api.deployRole(role!.id, { repo: target });
      onNotice(`Deployed “${role!.name}” to ${target}.`);
      onClose(); await onDeployed();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!role} onOpenChange={v => { if (!v && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Deploy “{role.name}”</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Deploys a standing agent for this role to a repo you can write. Runs in your container with your key.</p>
          <div><Label>Repo (ns/name)</Label><Input value={repo} onChange={e => setRepo(e.target.value)} placeholder="e.g. acme/api" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={busy || !repo.trim()}>{busy ? "Deploying…" : "Deploy to repo"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
