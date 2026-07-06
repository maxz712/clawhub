"use client";

import { useEffect, useState } from "react";
import { api, normalizeRolePermissions, type AccessRoleRow, type PermissionGroup, type Repo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";

/**
 * Access-role (RBAC, docs/redesign-v3.md §2) create/edit dialog: a role is a
 * named permission set + repo scope, assignable to any identity — human or
 * agent. Renders grouped permission checkboxes from the server's catalog
 * (`permissionGroups` from listAccessRoles) and submits `permissions:
 * string[]`. Pass `role` to edit an existing one (PATCH); omit to create.
 */
export function CustomRoleDialog({
  open, onOpenChange, permissionGroups, role, onCreated, onError,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  permissionGroups: PermissionGroup[];
  /** When set, the dialog edits this role instead of creating a new one. */
  role?: AccessRoleRow | null;
  onCreated: (name: string) => void | Promise<void>;
  onError: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [repoScope, setRepoScope] = useState<"all" | "selected">("all");
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Seed the form each time the dialog opens — from the role in edit mode
  // (legacy {push,review} rows normalize into the array form, so saving
  // migrates them), blank in create mode.
  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? "");
    setDescription(role?.description ?? "");
    setPermissions(new Set(role ? normalizeRolePermissions(role.permissions) : []));
    setRepoScope(role?.repoScope ?? "all");
    setRepoIds(role?.repoIds ?? []);
    api.listRepos().then(r => setRepos(r.repos)).catch(() => setRepos([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role?.id]);

  function toggle(key: string, on: boolean) {
    setPermissions(prev => {
      const next = new Set(prev);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }

  async function go() {
    if (!name.trim()) { onError("Name is required."); return; }
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        permissions: [...permissions],
        repoScope,
        repoIds: repoScope === "selected" ? repoIds : [],
      };
      if (role) await api.updateAccessRole(role.id, body);
      else await api.createAccessRole(body);
      const saved = name.trim();
      onOpenChange(false);
      await onCreated(saved);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{role ? `Edit role “${role.name}”` : "New role"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            A role is a permission set assignable to any identity — human or agent. It is a ceiling on what the identity may do; merge policy still gates every merge.
          </p>
          <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Docs-only developer" className="mt-1.5" /></div>
          <div><Label>Description</Label><Input value={description} onChange={e => setDescription(e.target.value)} placeholder="What is this role for?" className="mt-1.5" /></div>

          <div>
            <Label>Permissions</Label>
            <div className="mt-1.5 space-y-3 rounded-md border border-border/60 p-3">
              {permissionGroups.length === 0 && <p className="text-xs text-muted-foreground">No permission catalog available.</p>}
              {permissionGroups.map(g => (
                <div key={g.domain}>
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{g.domain}</div>
                  <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                    {g.permissions.map(perm => (
                      <div key={perm.key}>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="checkbox" className="accent-primary" checked={permissions.has(perm.key)}
                            onChange={e => toggle(perm.key, e.target.checked)} />
                          <span>{perm.label} <code className="font-mono text-[11px] text-muted-foreground">{perm.key}</code></span>
                        </label>
                        {perm.key === "change:merge" && permissions.has("change:merge") && (
                          <p className="flex items-start gap-1 pl-6 text-xs text-yellow-500">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            Grants merging at any risk (policy permitting) — including to agents.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <Label>Repo scope</Label>
            <div className="mt-1.5 flex gap-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="access-role-scope" className="accent-primary" checked={repoScope === "all"} onChange={() => setRepoScope("all")} /> All my repos</label>
              <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="access-role-scope" className="accent-primary" checked={repoScope === "selected"} onChange={() => setRepoScope("selected")} /> Selected repos</label>
            </div>
            {repoScope === "selected" && (
              <div className="mt-2 max-h-32 overflow-y-auto space-y-1 rounded-md border border-border/60 p-2">
                {(repos ?? []).length === 0 && <p className="text-xs text-muted-foreground">{repos === null ? "Loading repos…" : "No repos."}</p>}
                {(repos ?? []).map(r => (
                  <label key={r.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" className="accent-primary" checked={repoIds.includes(r.id)}
                      onChange={e => setRepoIds(ids => e.target.checked ? [...ids, r.id] : ids.filter(x => x !== r.id))} />
                    <span className="font-mono text-xs">{r.namespaceName}/{r.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={go} disabled={busy || !name.trim()}>{busy ? "Saving…" : role ? "Save role" : "Create role"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
