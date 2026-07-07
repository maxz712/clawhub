"use client";

import { useEffect, useState } from "react";
import { api, normalizeRolePermissions, type AccessRoleRow, type PermissionGroup } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CustomRoleDialog } from "@/components/custom-role-dialog";
import { KeyRound, Plus, Trash2, CheckCircle2, Pencil, Building2, Lock } from "lucide-react";

// ACCESS ROLES (RBAC, docs/redesign-v3.md §2): a role is a named permission
// set + repo scope, assignable to any identity — human or agent. Merge rights
// are role-based and uniform: change:merge grants merging to ANY holder, at
// any risk, policy permitting — there is no agent carve-out. v4 IA: roles
// govern humans AND agents, so this is a TOP-LEVEL page (/roles, in the nav
// next to People), no longer an agents-hub tab.

const CHIP_LIMIT = 5;

export default function AccessRolesPage() {
  const [roles, setRoles] = useState<AccessRoleRow[] | null>(null);
  const [permissionGroups, setPermissionGroups] = useState<PermissionGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editRole, setEditRole] = useState<AccessRoleRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AccessRoleRow | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await api.listAccessRoles();
      setRoles(r.roles);
      setPermissionGroups(r.permissionGroups ?? []);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  function flash(msg: string) { setNotice(msg); setError(null); }

  async function doDelete() {
    if (!confirmDelete) return;
    setBusy(true); setError(null);
    try { await api.deleteAccessRole(confirmDelete.id); flash(`Deleted role “${confirmDelete.name}”.`); setConfirmDelete(null); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Roles</h1>
          <p className="text-muted-foreground mt-1">
            A role is a permission set assignable to any identity — human or agent. <code className="font-mono text-xs">change:merge</code> grants merging at any risk, policy permitting.
          </p>
        </div>
        <Button size="sm" className="gap-2 shrink-0" onClick={() => { setNotice(null); setEditRole(null); setDialogOpen(true); }}>
          <Plus className="h-4 w-4" /> New role
        </Button>
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
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            No roles yet. Use <strong>New role</strong> to create a permission set you can assign to humans and agents.
          </div>
        ) : (
          <div className="space-y-2">
            {roles.map(r => {
              const perms = normalizeRolePermissions(r.permissions);
              const legacy = !Array.isArray(r.permissions);
              const shown = perms.slice(0, CHIP_LIMIT);
              const extra = perms.length - shown.length;
              return (
                <div key={r.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border bg-card p-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center flex-wrap gap-2">
                      <KeyRound className="h-4 w-4 text-primary shrink-0" />
                      <span className="font-medium truncate">{r.name}</span>
                      {r.isBuiltin && <Badge variant="outline" className="gap-1 text-[10px]" title="Seeded by ClawHub — read-only, clone by creating a new role."><Lock className="h-3 w-3" /> builtin</Badge>}
                      {r.ownerOrgId && <Badge variant="outline" className="gap-1 text-[10px]" title="Org-scoped role"><Building2 className="h-3 w-3" /> org</Badge>}
                      {legacy && <Badge variant="outline" className="text-[10px] text-yellow-500 border-yellow-500/30" title="Created before v3 RBAC — shown as its equivalent permission set. Editing migrates it.">legacy</Badge>}
                      <span className="text-xs text-muted-foreground">· {r.repoScope === "all" ? "all repos" : `${r.repoIds.length} selected repo${r.repoIds.length === 1 ? "" : "s"}`}</span>
                    </div>
                    {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                    <div className="flex items-center flex-wrap gap-1">
                      {perms.length === 0 && <span className="text-xs text-muted-foreground">No permissions</span>}
                      {shown.map(pk => (
                        <code key={pk} className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${pk === "change:merge" ? "border-yellow-500/40 text-yellow-500" : "border-border bg-muted/30 text-muted-foreground"}`} title={pk === "change:merge" ? "Grants merging at any risk (policy permitting) — including to agents." : undefined}>
                          {pk}
                        </code>
                      ))}
                      {extra > 0 && <span className="text-[11px] text-muted-foreground" title={perms.slice(CHIP_LIMIT).join(", ")}>+{extra} more</span>}
                    </div>
                  </div>
                  {!r.isBuiltin && (
                    <div className="flex items-center gap-2 shrink-0">
                      <Button variant="outline" size="sm" className="h-9 w-9 sm:h-7 sm:w-7" title="Edit role" disabled={busy} onClick={() => { setNotice(null); setEditRole(r); setDialogOpen(true); }}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" className="h-9 w-9 sm:h-7 sm:w-7" title="Delete role" disabled={busy} onClick={() => { setNotice(null); setConfirmDelete(r); }}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

      <CustomRoleDialog
        open={dialogOpen}
        onOpenChange={v => { setDialogOpen(v); if (!v) setEditRole(null); }}
        permissionGroups={permissionGroups}
        role={editRole}
        onError={setError}
        onCreated={async name => { flash(editRole ? `Saved role “${name}”.` : `Created role “${name}”.`); await load(); }}
      />

      {/* Confirm delete */}
      <Dialog open={!!confirmDelete} onOpenChange={v => { if (!v && !busy) setConfirmDelete(null); }}>
        <DialogContent>
          {confirmDelete && (
            <>
              <DialogHeader><DialogTitle>Delete role “{confirmDelete.name}”?</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">Permanently removes this role. Identities holding it fall back to their remaining grants. This cannot be undone.</p>
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
