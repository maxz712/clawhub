"use client";

import { useState } from "react";
import type { MergePolicy, Risk } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Trash2, Users } from "lucide-react";

const RISKS: Risk[] = ["low", "medium", "high", "critical"];

// Sensitive paths that always require a human code review server-side, kept as
// the Solo-mode backstop so loosening the gate never exposes governance/schema.
const SENSITIVE_BACKSTOP: Array<{ glob: string; requireHuman: boolean }> = [
  { glob: "**/migrations/**", requireHuman: true },
  { glob: "**/*.sql", requireHuman: true },
  { glob: "deploy/**", requireHuman: true },
  { glob: "**/Dockerfile", requireHuman: true },
  { glob: ".clawhub/policies/**", requireHuman: true },
];

function describePolicy(p: MergePolicy): string {
  const code = p.codeReviewRequiredAtRisk ?? "high";
  let human: string;
  if (p.requireHumanApproval === "always") human = "Every merge needs a human approval.";
  else if (p.requireHumanApproval === "never") human = "Agent approvals can merge at any risk (no human required).";
  else human = `A human must approve at ${p.requireHumanApprovalLevel} risk or above.`;
  return `${human} At ${code} risk or above (and on sensitive paths), that human must have reviewed the code — a behavior-only approval won't unblock it. Requires ${p.minApprovalsTotal} total approval${p.minApprovalsTotal === 1 ? "" : "s"}${p.minApprovalsHuman > 0 ? ` (${p.minApprovalsHuman} human)` : ""}${p.ciRequired ? "; CI must pass" : ""}.`;
}

export function MergePolicyEditor({ initial, onSave }: { initial: MergePolicy; onSave: (p: MergePolicy) => Promise<void> }) {
  const [p, setP] = useState<MergePolicy>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true); setError(null);
    try { await onSave(p); } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  // Solo mode: let low/medium self-merges flow while KEEPING the sensitive-path
  // backstop and requiring a human at high+. Matches docs/governance.md "vibecoding".
  function applySolo() {
    const existing = new Map(p.pathOverrides.map(o => [o.glob, o]));
    for (const b of SENSITIVE_BACKSTOP) if (!existing.has(b.glob)) existing.set(b.glob, b);
    setP({
      ...p,
      allowSelfReview: true,
      requireHumanApproval: "if_risk_at_least",
      requireHumanApprovalLevel: "high",
      codeReviewRequiredAtRisk: "high",
      minApprovalsTotal: 1,
      minApprovalsHuman: 0,
      ciRequired: true,
      pathOverrides: Array.from(existing.values()),
    });
  }

  const thresholdDisabled = p.requireHumanApproval !== "if_risk_at_least";

  return (
    <div className="space-y-4">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="flex items-center justify-between rounded-lg border bg-card p-3">
        <div className="text-sm">
          <div className="font-medium">Solo mode</div>
          <div className="text-xs text-muted-foreground">Self-merge low/medium changes; high-risk + sensitive paths still need a human who read the code.</div>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={applySolo}><Users className="h-4 w-4" /> Apply</Button>
      </div>

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
        <div className={`space-y-2 ${thresholdDisabled ? "opacity-50 pointer-events-none" : ""}`}>
          <Label>Risk threshold</Label>
          <Select value={p.requireHumanApprovalLevel} onValueChange={v => setP({ ...p, requireHumanApprovalLevel: v as Risk })} disabled={thresholdDisabled}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {RISKS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Only applies when set to &quot;If risk ≥ threshold&quot;.</p>
        </div>
        <div className="space-y-2">
          <Label>Code review required at risk</Label>
          <Select value={p.codeReviewRequiredAtRisk ?? "high"} onValueChange={v => setP({ ...p, codeReviewRequiredAtRisk: v as Risk })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {RISKS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">At/above this risk a human must have reviewed the code.</p>
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
        <p className="text-xs text-muted-foreground">Their approval counts toward the total on low-risk changes — never a substitute for the human required at medium+.</p>
      </div>

      <div className="space-y-2">
        <Label>Path overrides</Label>
        <p className="text-xs text-muted-foreground">Force (or relax) human review on matching paths. Sensitive paths always require a human code review.</p>
        <div className="space-y-2">
          {p.pathOverrides.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                placeholder="deploy/**"
                className="flex-1 font-mono text-xs"
                value={o.glob}
                onChange={e => {
                  const next = [...p.pathOverrides];
                  next[i] = { ...next[i], glob: e.target.value };
                  setP({ ...p, pathOverrides: next });
                }}
              />
              <Select
                value={o.requireHuman ? "yes" : "no"}
                onValueChange={v => {
                  const next = [...p.pathOverrides];
                  next[i] = { ...next[i], requireHuman: v === "yes" };
                  setP({ ...p, pathOverrides: next });
                }}
              >
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">Require human</SelectItem>
                  <SelectItem value="no">No override</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="ghost" size="icon-sm" aria-label="Remove override" onClick={() => setP({ ...p, pathOverrides: p.pathOverrides.filter((_, j) => j !== i) })}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => setP({ ...p, pathOverrides: [...p.pathOverrides, { glob: "", requireHuman: true }] })}>
          <Plus className="h-4 w-4" /> Add override
        </Button>
      </div>

      <Alert>
        <AlertDescription className="text-xs">{describePolicy(p)}</AlertDescription>
      </Alert>

      <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save policy"}</Button>
    </div>
  );
}
