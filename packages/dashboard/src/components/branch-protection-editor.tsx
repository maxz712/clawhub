"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, type BranchProtection, type MergeMethod } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ShieldCheck, CheckCircle2 } from "lucide-react";

type Branch = { name: string; isDefault: boolean; protection?: BranchProtection | null };
const METHODS: MergeMethod[] = ["merge", "squash", "rebase"];

/**
 * Per-branch protection editor (Team+). Replaces the old "planned but not yet
 * editable" placeholder. Wires the PATCH /branches/:name/protection route; the
 * rules are enforced by changes.ts (merge methods / CI / required approvals /
 * requirePullRequest) and post-push.ts (force-push / deletion).
 */
export function BranchProtectionEditor({ ns, repo }: { ns: string; repo: string }) {
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [form, setForm] = useState<BranchProtection>({});
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState(false);

  const applyBranch = useCallback((list: Branch[], name: string) => {
    const b = list.find(x => x.name === name);
    setForm({ ...(b?.protection ?? {}) });
    setSaved(false); setError(null); setUpgrade(false);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.getBranches(ns, repo);
      setBranches(r.branches);
      const initial = r.branches.find(b => b.isDefault)?.name ?? r.branches[0]?.name ?? "";
      setSelected(initial);
      applyBranch(r.branches, initial);
    } catch { setBranches([]); }
  }, [ns, repo, applyBranch]);

  useEffect(() => { void load(); }, [load]);

  function set<K extends keyof BranchProtection>(k: K, v: BranchProtection[K]) {
    setForm(f => ({ ...f, [k]: v })); setSaved(false);
  }
  function toggleMethod(m: MergeMethod) {
    const cur = form.allowedMergeMethods ?? [];
    const next = cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m];
    set("allowedMergeMethods", next.length ? next : undefined);
  }

  async function submit(payload: BranchProtection | { clear: true }) {
    if (!selected) return;
    setPending(true); setSaved(false); setError(null); setUpgrade(false);
    try {
      await api.setBranchProtection(ns, repo, selected, payload);
      setSaved(true);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === "upgrade_required") setUpgrade(true);
      else if (e instanceof ApiError && e.status === 403) setError("You need repo-admin access to edit branch protection.");
      else setError((e as Error).message);
    } finally { setPending(false); }
  }
  const save = () => submit(form);

  if (branches === null) return <div className="text-xs text-muted-foreground">Loading branches…</div>;
  if (branches.length === 0) return <p className="text-xs text-muted-foreground">No branches yet — push code first to protect a branch.</p>;

  const methods = form.allowedMergeMethods ?? [];

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <Label className="text-sm font-medium">Branch protection</Label>
      </div>

      {upgrade && (
        <Alert>
          <AlertDescription className="text-xs">
            Branch protection is a <strong>Team</strong> feature.{" "}
            <Link href="/pricing" className="underline underline-offset-2">Upgrade</Link> to require approvals, a Change, or CI before merge.
          </AlertDescription>
        </Alert>
      )}
      {error && <Alert variant="destructive"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}

      <div className="space-y-1.5">
        <Label className="text-xs">Branch</Label>
        <Select value={selected} onValueChange={v => { if (v) { setSelected(v); applyBranch(branches, v); } }}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {branches.map(b => <SelectItem key={b.name} value={b.name}>{b.name}{b.isDefault ? " (default)" : ""}{b.protection ? " — protected" : ""}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-3">
        <Toggle label="Require a Change (no direct pushes to this branch)" checked={!!form.requirePullRequest} onChange={v => set("requirePullRequest", v)} />
        <Toggle label="Require CI success before merge" checked={!!form.requireCiSuccess} onChange={v => set("requireCiSuccess", v)} />
        <Toggle label="Block force-push" checked={!!form.blockForcePush} onChange={v => set("blockForcePush", v)} />
        <Toggle label="Block deletion" checked={!!form.blockDeletion} onChange={v => set("blockDeletion", v)} />

        <div className="flex items-center justify-between gap-3 text-sm pt-1">
          <span className="min-w-0">Required approving reviews</span>
          <Input
            type="number" min={0} max={10}
            value={form.requiredApprovals ?? 0}
            onChange={e => { const n = Math.max(0, Math.min(10, Math.floor(Number(e.target.value) || 0))); set("requiredApprovals", n || undefined); }}
            className="shrink-0 w-20"
          />
        </div>

        <div className="pt-1">
          <Label className="text-xs">Allowed merge methods <span className="text-muted-foreground font-normal">— none = all</span></Label>
          <div className="flex gap-3 mt-1">
            {METHODS.map(m => (
              <label key={m} className="flex items-center gap-1.5 text-xs capitalize cursor-pointer">
                <input type="checkbox" checked={methods.includes(m)} onChange={() => toggleMethod(m)} className="accent-primary" />
                {m}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => void save()} disabled={pending}>{pending ? "Saving…" : "Save protection"}</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => void submit({ clear: true })}>Clear</Button>
        {saved && <span className="flex items-center gap-1 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" /> Saved</span>}
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Button type="button" variant={checked ? "default" : "outline"} size="sm" onClick={() => onChange(!checked)}>{checked ? "On" : "Off"}</Button>
    </label>
  );
}
