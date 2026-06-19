import type { TriggerKind } from "@/lib/api";
import { GitCommitHorizontal, GitMerge, Clock, Zap, Bot } from "lucide-react";

// "agent" is a CI-run origin (a standing-agent run) but not a pipeline trigger kind.
type BadgeKind = TriggerKind | "agent";

const STYLES: Record<BadgeKind, string> = {
  push: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  merge: "bg-primary/15 text-primary border-primary/30",
  schedule: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  event: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  agent: "bg-primary/15 text-primary border-primary/30",
};

const ICONS: Record<BadgeKind, typeof Clock> = {
  push: GitCommitHorizontal,
  merge: GitMerge,
  schedule: Clock,
  event: Zap,
  agent: Bot,
};

const LABELS: Record<BadgeKind, string> = {
  push: "on push",
  merge: "on merge",
  schedule: "scheduled",
  event: "on event",
  agent: "standing agent",
};

/** Trigger origin badge for a pipeline or a CI run. */
export function TriggerBadge({ kind }: { kind: BadgeKind }) {
  const Icon = ICONS[kind];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STYLES[kind]}`}>
      <Icon className="h-3 w-3" />
      {LABELS[kind]}
    </span>
  );
}
