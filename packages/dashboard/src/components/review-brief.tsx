"use client";

import { Children, type ReactNode } from "react";
import type { ReviewBrief } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Flag, History, GitCompare, ShieldAlert } from "lucide-react";

/**
 * The **Critical Decisions** slot of the Review Brief (M1). Renders the
 * deterministic focus floor the server synthesized on push: rollback/co-change
 * callouts first (the strongest signals), then the ranked sensitive decisions,
 * each clickable to jump into the diff. Later milestones plug their own cards
 * into this slot via `children` (M4 advisory review, M5 verification) — the
 * layout contract says nobody re-layouts, cards just get added here.
 *
 * Returns null when the brief has no callouts and no derived focus (the
 * "null-brief fallback renders today's layout" rule) — unless `children` are
 * present, in which case the slot still renders to host them.
 */
export function ReviewBriefCard({ brief, onJump, children }: {
  brief: ReviewBrief | null | undefined;
  onJump?: (path: string, line: number) => void;
  children?: ReactNode;
}) {
  const callouts = brief?.callouts ?? [];
  const derivedFocus = brief?.derivedFocus ?? [];
  const hasContent = callouts.length > 0 || derivedFocus.length > 0;
  // Children.toArray filters out null/false/undefined, so a slot passed
  // `{cond && <Card/>}` that evaluates falsy doesn't force an empty card.
  const hasChildren = Children.toArray(children).length > 0;
  if (!hasContent && !hasChildren) return null;

  // Group derived focus by file for a compact, decision-per-file list.
  const byFile = new Map<string, typeof derivedFocus>();
  for (const f of derivedFocus) {
    const arr = byFile.get(f.path) ?? [];
    arr.push(f);
    byFile.set(f.path, arr);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Flag className="h-4 w-4 text-amber-400" />
          Critical decisions
          <span className="ml-1 text-[10px] font-medium uppercase tracking-wider text-sky-300 border border-sky-400/40 rounded px-1.5 py-0.5">
            auto-derived
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {callouts.map((co, i) => (
          <div key={`co-${i}`}
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
              co.source === "rollback"
                ? "border-destructive/40 bg-destructive/10 text-destructive-foreground"
                : "border-amber-400/40 bg-amber-500/10 text-amber-200"
            }`}>
            {co.source === "rollback"
              ? <History className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
              : <GitCompare className="h-4 w-4 mt-0.5 shrink-0 text-amber-400" />}
            <span className="font-sans">{co.message}</span>
          </div>
        ))}

        {byFile.size > 0 && (
          <ul className="space-y-2">
            {[...byFile.entries()].map(([path, flags]) => (
              <li key={path} className="text-sm">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <ShieldAlert className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                  <code className="font-mono text-xs text-foreground truncate">{path}</code>
                </div>
                <ul className="mt-1 ml-5 space-y-1">
                  {flags.map((f, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => onJump?.(f.path, f.startLine)}
                        className="text-left text-xs text-muted-foreground hover:text-foreground underline decoration-dotted underline-offset-2"
                      >
                        lines {f.startLine}–{f.endLine} · {f.reason}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        {!hasContent && (
          <p className="text-xs text-muted-foreground">No sensitive decisions flagged in this change.</p>
        )}

        {children}
      </CardContent>
    </Card>
  );
}
