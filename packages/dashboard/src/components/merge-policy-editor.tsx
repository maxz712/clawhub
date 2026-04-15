"use client";

import { useState } from "react";
import type { MergePolicy, Risk } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function MergePolicyEditor({ initial, onSave }: { initial: MergePolicy; onSave: (p: MergePolicy) => Promise<void> }) {
  const [p, setP] = useState<MergePolicy>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true); setError(null);
    try { await onSave(p); } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  return (
    <div className="space-y-4">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Require human approval</Label>
          <Select value={p.requireHumanApproval} onValueChange={v => setP({ ...p, requireHumanApproval: v as MergePolicy["requireHumanApproval"] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="always">Always</SelectItem>
              <SelectItem value="if_risk_at_least">If risk ≥ threshold</SelectItem>
              <SelectItem value="never">Never</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Risk threshold</Label>
          <Select value={p.requireHumanApprovalLevel} onValueChange={v => setP({ ...p, requireHumanApprovalLevel: v as Risk })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="low">low</SelectItem>
              <SelectItem value="medium">medium</SelectItem>
              <SelectItem value="high">high</SelectItem>
              <SelectItem value="critical">critical</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Min total approvals</Label>
          <Input type="number" min={0} value={p.minApprovalsTotal} onChange={e => setP({ ...p, minApprovalsTotal: Number(e.target.value) })} />
        </div>
        <div className="space-y-2">
          <Label>Min human approvals</Label>
          <Input type="number" min={0} value={p.minApprovalsHuman} onChange={e => setP({ ...p, minApprovalsHuman: Number(e.target.value) })} />
        </div>
      </div>

      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.allowSelfReview} onChange={e => setP({ ...p, allowSelfReview: e.target.checked })} />
          Allow self-review
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.ciRequired} onChange={e => setP({ ...p, ciRequired: e.target.checked })} />
          CI required
        </label>
      </div>

      <div className="space-y-2">
        <Label>Trusted agents (comma-separated)</Label>
        <Input value={p.trustedAgents.join(", ")} onChange={e => setP({ ...p, trustedAgents: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
      </div>

      <div className="space-y-2">
        <Label>Path overrides (glob:require_human, one per line)</Label>
        <textarea
          className="w-full rounded border bg-background p-2 font-mono text-xs"
          rows={4}
          value={p.pathOverrides.map(o => `${o.glob}:${o.requireHuman}`).join("\n")}
          onChange={e => setP({
            ...p,
            pathOverrides: e.target.value.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
              const [glob, val] = l.split(":");
              return { glob, requireHuman: String(val).trim() === "true" };
            }),
          })}
        />
      </div>

      <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save policy"}</Button>
    </div>
  );
}
