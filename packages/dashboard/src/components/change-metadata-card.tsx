import type { Change, MergeDecision } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RiskBadge } from "./risk-badge";
import { StatusBadge } from "./status-badge";
import { CiStatusPill } from "./ci-status-pill";
import { humanizeMergeReason } from "@/lib/merge-reason";

export function ChangeMetadataCard({ change, mergeable }: { change: Change; mergeable: MergeDecision }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base leading-snug">{change.intent}</CardTitle>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <RiskBadge risk={change.risk} />
          <StatusBadge status={change.status} />
          <CiStatusPill status={change.ciStatus} />
          {change.hasConflicts && <Badge className="font-medium uppercase tracking-wider text-[10px] bg-destructive/15 text-destructive border border-destructive/30">conflicts</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">Branch</div>
          <code className="font-mono text-xs">{change.branch}</code>
        </div>

        {change.scope.length > 0 && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">Scope</div>
            <div className="flex flex-wrap gap-1">
              {change.scope.map(s => <code key={s} className="text-xs px-1.5 py-0.5 rounded bg-muted">{s}</code>)}
            </div>
          </div>
        )}

        {change.reviewFocus.length > 0 && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">Review focus</div>
            <ul className="space-y-1 text-xs">
              {change.reviewFocus.map((f, i) => (
                <li key={i}><code className="text-primary">{f.path}:{f.startLine}-{f.endLine}</code>{f.note && <span className="text-muted-foreground"> — {f.note}</span>}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="pt-2 border-t">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">Merge</div>
          {mergeable.mergeable ? (
            <div className="text-primary text-sm">Ready to merge</div>
          ) : (
            <div className="text-sm">
              <span className="text-yellow-400">Blocked</span>
              <span className="block text-muted-foreground text-xs mt-0.5">{humanizeMergeReason(mergeable.reason)}</span>
              {mergeable.reason === "needs_human_approval" && (
                <span className="block text-muted-foreground text-xs mt-1">
                  You&apos;re the supervisor — approve your own agent&apos;s change as the human, or turn on <span className="font-medium text-foreground">Solo mode</span> in Settings to let your own approval count on low/medium work.
                </span>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
