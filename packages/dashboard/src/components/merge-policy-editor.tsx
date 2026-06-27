"use client";

import { useEffect, useState } from "react";
import type { MergePolicy, Risk } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Trash2, Users, Lock, CheckCircle2 } from "lucide-react";

const RISKS: Risk[] = ["low", "medium", "high", "critical"];

// The non-removable baseline sensitive-path globs the server ALWAYS treats as
// requiring a human code review — `merge-policy.ts:BASELINE_SENSITIVE_GLOBS`. A
// per-repo path override can ADD to this but can never shrink it; rendered
// read-only so users understand they can't be removed here.
const BASELINE_SENSITIVE_GLOBS = [
  ".clawhub/policies/**",
  ".clawhub/ci/**",
  "scripts/**",
  "**/scripts/**",
  "**/migrations/**",
  "**/*.sql",
  "deploy/**",
  "**/Dockerfile",
  "docker-compose*.yml",
];

// `requireIndependentApprover` is enforced server-side (merge-policy.ts) but may
// not yet be in the shared MergePolicy type — read/write it through this local
// extension so the editor compiles regardless of when the field lands in api.ts.
type PolicyWithIndependent = MergePolicy & { requireIndependentApprover?: boolean };

function describePolicy(p: PolicyWithIndependent): string {
  const code = p.codeReviewRequiredAtRisk ?? "high";
  let human: string;
  if (p.requireHumanApproval === "always") {
    human = "Every merge needs a human approval.";
  } else if (p.requireHumanApproval === "never") {
    // Be honest: "never" + no human floor means NO human is guaranteed — except
    // on baseline sensitive paths, which always require a human code review.
    human = p.minApprovalsHuman > 0
      ? `Agent approvals can merge most changes, but ${p.minApprovalsHuman} human approval${p.minApprovalsHuman === 1 ? " is" : "s are"} still required.`
      : "No human approval is required to merge — except on baseline sensitive paths (below), which always need a human code review.";
  } else {
    human = `A human must approve at ${p.requireHumanApprovalLevel} risk or above.`;
  }
  const independent = p.requireIndependentApprover
    ? " When a human code review is required, it must come from someone OTHER than the change's author."
    : "";
  return `${human} At ${code} risk or above (and on sensitive paths), that human must have reviewed the code — a behavior-only approval won't unblock it.${independent} Requires ${p.minApprovalsTotal} total approval${p.minApprovalsTotal === 1 ? "" : "s"}${p.minApprovalsHuman > 0 ? ` (${p.minApprovalsHuman} human)` : ""}${p.ciRequired ? "; CI must pass" : ""}.`;
}

export function MergePolicyEditor({ initial, onSave, onApplySolo, isOrg = false }: { initial: MergePolicy; onSave: (p: MergePolicy) => Promise<void>; onApplySolo?: () => Promise<void>; isOrg?: boolean }) {
  // Default the independent-approver toggle ON for org repos when the policy
  // hasn't set it yet — mirrors the server default (`?? namespaceType==='org'`).
  const [p, setP] = useState<PolicyWithIndependent>(() => {
    const seed = initial as PolicyWithIndependent;
    return seed.requireIndependentApprover === undefined
      ? { ...seed, requireIndependentApprover: isOrg }
      : seed;
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [soloPending, setSoloPending] = useState(false);
  const [saved, setSaved] = useState(false);

  // Auto-dismiss the transient "Saved" chip ~2s after a successful save.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(t);
  }, [saved]);

  async function save() {
    setPending(true); setError(null); setSaved(false);
    try { await onSave(p); setSaved(true); } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  // Solo mode applies the CANONICAL server preset (POST .../merge-policy/solo-mode,
  // the same one the Solo-mode toggle and `ch repo solo-mode` use) — never a
  // separate client-side recipe that could drift. The sensitive-path + high-risk
  // code-review backstops are enforced server-side as a non-removable baseline.
  async function applySolo() {
    if (!onApplySolo) return;
    setSoloPending(true); setError(null);
    try { await onApplySolo(); } catch (e) { setError((e as Error).message); }
    finally { setSoloPending(false); }
  }

  const thresholdDisabled = p.requireHumanApproval !== "if_risk_at_least";

  return (
    <div className="space-y-4">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {onApplySolo && (
        <Card>
          <CardContent className="flex items-start justify-between gap-4 p-3">
          <div className="text-sm space-y-1">
            <div className="font-medium flex items-center gap-2">
              <Users className="h-4 w-4" /> Solo mode
              {p.allowSelfReview && <span className="text-xs font-normal text-primary">· on</span>}
            </div>
            <div className="text-xs text-muted-foreground">
              Raises the human-approval threshold so your agent&apos;s low/medium changes can merge on
              <strong> your</strong> approval alone (or auto-merge). <strong>You approving your agent&apos;s work always counts</strong> — this only
              changes whether the <em>agent approving its own work</em> is allowed (turns on self-review).
              High/critical risk and sensitive paths (migrations, <code className="font-mono">*.sql</code>, <code className="font-mono">deploy/**</code>, Dockerfile, compose, policies) still require a human who read the code.
            </div>
          </div>
          <Button variant="outline" size="sm" className="gap-2 shrink-0" onClick={applySolo} disabled={soloPending}>
            <Users className="h-4 w-4" /> {soloPending ? "Applying…" : "Apply"}
          </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

      <div className="flex flex-col gap-y-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={p.allowSelfReview} onChange={e => setP({ ...p, allowSelfReview: e.target.checked })} />
          <span>Allow self-review
            <span className="block text-xs text-muted-foreground">The authoring agent may approve its own work (low-risk only). You approving your agent&apos;s work is always allowed and unaffected by this.</span>
          </span>
        </label>
        {/* Separation of duties: when a human code review is required, it must
            come from someone other than the change's author. Defaults on for
            org repos. Enforced server-side (merge-policy.ts). */}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={!!p.requireIndependentApprover} onChange={e => setP({ ...p, requireIndependentApprover: e.target.checked })} />
          <span>Require independent approver
            <span className="block text-xs text-muted-foreground">The change author cannot approve their own change — when a human code review is required, it must come from a different human. Recommended for teams; on by default for org repos.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={p.ciRequired} onChange={e => setP({ ...p, ciRequired: e.target.checked })} />
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
            <div key={i} className="flex flex-col sm:flex-row sm:items-center gap-2">
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
                <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
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

      {/* Non-removable baseline. These globs ALWAYS require a human code review
          server-side — a path override can add to them but can never shrink
          them. Shown read-only so the rule is legible, not a surprise at merge. */}
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5 text-muted-foreground" /> Baseline sensitive paths (always require a human code review)
        </Label>
        <p className="text-xs text-muted-foreground">Enforced by ClawHub and not removable here — a path override can only add to these.</p>
        <div className="flex flex-wrap gap-1.5 rounded-lg border bg-muted/30 p-2.5">
          {BASELINE_SENSITIVE_GLOBS.map(g => (
            <code key={g} className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              <Lock className="h-3 w-3" />{g}
            </code>
          ))}
        </div>
      </div>

      <Alert>
        <AlertDescription className="text-xs">{describePolicy(p)}</AlertDescription>
      </Alert>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save policy"}</Button>
        {saved && <span className="flex items-center gap-1 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" /> Saved</span>}
      </div>
    </div>
  );
}
