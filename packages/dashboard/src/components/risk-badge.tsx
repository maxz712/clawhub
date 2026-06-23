import { Badge } from "@/components/ui/badge";
import type { Risk } from "@/lib/api";

/**
 * Single source of truth for per-risk color classes — bg + text + border-color
 * only (no `border` width utility), so any consumer can pair it with its own
 * `border` and box style without the two maps drifting apart. Shared with
 * `evidence-panel.tsx`.
 */
export const RISK_COLOR: Record<Risk, string> = {
  low: "bg-primary/15 text-primary border-primary/30",
  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  critical: "bg-destructive/15 text-destructive border-destructive/30",
};

export function RiskBadge({ risk }: { risk: Risk }) {
  return <Badge className={`font-medium uppercase tracking-wider text-[10px] border ${RISK_COLOR[risk]}`}>{risk}</Badge>;
}
