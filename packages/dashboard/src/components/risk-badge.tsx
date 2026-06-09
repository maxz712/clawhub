import { Badge } from "@/components/ui/badge";
import type { Risk } from "@/lib/api";

const STYLES: Record<Risk, string> = {
  low: "bg-primary/15 text-primary border border-primary/30",
  medium: "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30",
  high: "bg-orange-500/15 text-orange-400 border border-orange-500/30",
  critical: "bg-destructive/15 text-destructive border border-destructive/30",
};

export function RiskBadge({ risk }: { risk: Risk }) {
  return <Badge className={`font-medium uppercase tracking-wider text-[10px] ${STYLES[risk]}`}>{risk}</Badge>;
}
