"use client";

import type { VerificationRun } from "@/lib/api";
import { CheckCircle2, XCircle, ShieldCheck, ShieldOff, AlertTriangle, FileText } from "lucide-react";

// Conformance verification panel (M5). Renders the head-pinned attestation: a
// spec-basis chip (issue/description/inferred — the incentive to write better
// descriptions is visible), per-check rows, and an amber "undeclared scope"
// banner when the verifier found behavior the description didn't mention.
// Labeled as a SANDBOXED-RUN FINDING — a different trust tier from the advisory
// reviewer's LLM opinion; the two are never merged.

const BASIS_LABEL: Record<string, string> = { issue: "issue spec", description: "description spec", inferred: "inferred spec" };
const BASIS_STYLE: Record<string, string> = {
  issue: "text-primary border-primary/40",
  description: "text-sky-300 border-sky-400/40",
  inferred: "text-amber-300 border-amber-400/40",
};

export function VerificationPanel({ verification }: { verification: VerificationRun | null | undefined }) {
  if (!verification) return null;
  const v = verification;
  const ok = v.status === "success";
  // A success attestation that the merge gate no longer honors — the verifying
  // agent was disabled (kill switch / circuit-breaker auto-pause) or self-verified
  // (#78). `counts` is only sent for success rows, so treat missing as counting.
  const stale = ok && v.counts === false;
  const staleMsg = v.staleReason === "self_verify"
    ? "The verifying agent is the change's own author, so this attestation can't satisfy the review gate."
    : "The verifying agent has been disabled (kill switch or repeated failures), so the merge gate no longer honors this attestation. Re-run verification with an active agent to regain autonomy.";
  const basis = v.specBasis ?? "inferred";
  const undeclared = v.divergence?.undeclared ?? [];

  return (
    <div className={`rounded-md border ${stale ? "border-amber-400/40 bg-amber-500/[0.06]" : ok ? "border-primary/30 bg-primary/[0.05]" : "border-destructive/30 bg-destructive/[0.05]"}`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        {stale
          ? <ShieldOff className="h-4 w-4 shrink-0 text-amber-400" />
          : <ShieldCheck className={`h-4 w-4 shrink-0 ${ok ? "text-primary" : "text-destructive"}`} />}
        <span className="text-sm font-medium">Verification</span>
        <span className={`text-[10px] font-medium uppercase tracking-wider border rounded px-1.5 py-0.5 ${BASIS_STYLE[basis]}`}>
          {BASIS_LABEL[basis]}
        </span>
        <span className={`ml-auto text-[10px] font-medium uppercase tracking-wider ${stale ? "text-amber-300" : ok ? "text-primary" : "text-destructive"}`}>
          {stale ? "no longer counts" : ok ? "attested" : "inconclusive"} · {v.passedCount}/{v.passedCount + v.failedCount}
        </span>
      </div>
      <div className="px-3 py-2.5 space-y-2 text-sm">
        {stale && (
          <div className="flex items-start gap-2 rounded border border-amber-400/40 bg-amber-500/10 px-2.5 py-1.5 text-amber-200 text-xs">
            <ShieldOff className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
            <div>
              <div className="font-medium">Attestation no longer counts</div>
              <p className="mt-0.5">{staleMsg}</p>
            </div>
          </div>
        )}
        {basis === "inferred" && (
          <p className="text-xs text-muted-foreground">
            No linked issue or description to conform to — the verifier inferred the spec from the diff. An inferred-spec attestation auto-merges only at low risk. Link an issue or write a description to earn more autonomy.
          </p>
        )}
        {undeclared.length > 0 && (
          <div className="flex items-start gap-2 rounded border border-amber-400/40 bg-amber-500/10 px-2.5 py-1.5 text-amber-200 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
            <div>
              <div className="font-medium">Undeclared scope</div>
              <ul className="mt-0.5 space-y-0.5">
                {undeclared.map((u, i) => (
                  <li key={i}>{u.path ? <code className="font-mono">{u.path}</code> : null} {u.description}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {v.checks.length > 0 && (
          <ul className="space-y-1">
            {v.checks.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                {c.ok ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" /> : <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-destructive" />}
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mt-0.5">{c.kind}</span>
                <span className="flex-1">
                  {c.name}
                  {c.observed && <span className="block text-muted-foreground font-mono text-[11px] truncate">{c.observed}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {v.specExcerpt && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer inline-flex items-center gap-1"><FileText className="h-3 w-3" /> spec checked</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted/40 p-2">{v.specExcerpt}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
