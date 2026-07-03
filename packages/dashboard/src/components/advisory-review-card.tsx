"use client";

import { useState } from "react";
import type { Review } from "@/lib/api";
import { Bot, Info, ThumbsUp, AlertTriangle, MessageSquare } from "lucide-react";

// The native ADVISORY reviewer's card (M4), rendered inside the Review Brief's
// "Critical decisions" slot. Shows the model, verdict, intent-vs-diff summary,
// and up to five focus decisions — labeled clearly as an LLM opinion that
// informs but never gates ("inference informs, determinism decides"). A
// first-render explainer + an inline disable keep it honest and dismissible.

function verdictChip(verdict: string) {
  if (verdict === "approve") return { icon: ThumbsUp, label: "looks good", cls: "text-primary border-primary/40" };
  if (verdict === "request_changes") return { icon: AlertTriangle, label: "concerns", cls: "text-amber-300 border-amber-400/40" };
  return { icon: MessageSquare, label: "comment", cls: "text-sky-300 border-sky-400/40" };
}

export function AdvisoryReviewCard({ reviews, onJump, onDisable }: {
  reviews: Review[];
  onJump?: (path: string, line: number) => void;
  onDisable?: () => void;
}) {
  // Latest advisory review only — a re-review supersedes the prior one server-side,
  // but guard the client too by taking the most recent.
  const advisory = reviews.filter(r => r.advisory).sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))[0];
  const [showExplainer, setShowExplainer] = useState(true);
  if (!advisory) return null;
  const contract = advisory.contract;
  const verdict = verdictChip(advisory.verdict);
  const VIcon = verdict.icon;
  const focus = contract?.additionalFocus ?? [];
  const model = contract?.model;

  return (
    <div className="rounded-md border border-sky-400/30 bg-sky-500/[0.06]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-sky-400/20">
        <Bot className="h-4 w-4 text-sky-300 shrink-0" />
        <span className="text-sm font-medium">Advisory review</span>
        {model && <span className="text-[10px] font-medium uppercase tracking-wider text-sky-300 border border-sky-400/40 rounded px-1.5 py-0.5">{model}</span>}
        <span className={`ml-auto inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider border rounded px-1.5 py-0.5 ${verdict.cls}`}>
          <VIcon className="h-3 w-3" /> {verdict.label}
        </span>
      </div>
      <div className="px-3 py-2.5 space-y-2.5 text-sm">
        {showExplainer && (
          <div className="flex items-start gap-2 rounded bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              An AI reviewer&apos;s opinion — it <strong>informs</strong> but never gates the merge. Determinism decides.{" "}
              <button className="underline" onClick={() => setShowExplainer(false)}>Got it</button>
              {onDisable && <> · <button className="underline" onClick={onDisable}>Disable for this repo</button></>}
            </span>
          </div>
        )}
        {contract?.intentVsDiff && (
          <p className="whitespace-pre-wrap break-words">{contract.intentVsDiff}</p>
        )}
        {!contract && advisory.summary && (
          <p className="whitespace-pre-wrap break-words">{advisory.summary}</p>
        )}
        {focus.length > 0 && (
          <ul className="space-y-1">
            {focus.map((f, i) => (
              <li key={i} className="text-xs">
                <button
                  type="button"
                  onClick={() => onJump?.(f.path, f.startLine)}
                  className="text-left text-muted-foreground hover:text-foreground"
                >
                  <code className="font-mono text-foreground">{f.path}</code>:{f.startLine}
                  {f.endLine !== f.startLine ? `–${f.endLine}` : ""} · {f.reason}
                </button>
              </li>
            ))}
          </ul>
        )}
        {!showExplainer && onDisable && (
          <button className="text-xs underline text-muted-foreground hover:text-foreground" onClick={onDisable}>Disable advisory review for this repo</button>
        )}
      </div>
    </div>
  );
}
