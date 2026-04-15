import { Badge } from "@/components/ui/badge";
import type { ChangeStatus } from "@/lib/api";

const STYLES: Record<ChangeStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  approved: "bg-primary/15 text-primary",
  changes_requested: "bg-yellow-500/15 text-yellow-400",
  merged: "bg-blue-500/15 text-blue-400",
  rolled_back: "bg-destructive/15 text-destructive",
};

const LABELS: Record<ChangeStatus, string> = {
  pending: "pending",
  approved: "approved",
  changes_requested: "changes requested",
  merged: "merged",
  rolled_back: "rolled back",
};

export function StatusBadge({ status }: { status: ChangeStatus }) {
  return <Badge className={`font-mono text-[10px] uppercase ${STYLES[status]}`}>{LABELS[status]}</Badge>;
}
