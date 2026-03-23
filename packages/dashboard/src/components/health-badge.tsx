"use client";

import { cn } from "@/lib/utils";

type HealthLevel = "green" | "yellow" | "red";

const healthConfig: Record<HealthLevel, { dot: string; bg: string; text: string; label: string }> = {
  green: {
    dot: "bg-green-400",
    bg: "bg-green-500/10",
    text: "text-green-400",
    label: "Healthy",
  },
  yellow: {
    dot: "bg-yellow-400",
    bg: "bg-yellow-500/10",
    text: "text-yellow-400",
    label: "Needs Attention",
  },
  red: {
    dot: "bg-red-400",
    bg: "bg-red-500/10",
    text: "text-red-400",
    label: "Blocked",
  },
};

export function HealthBadge({ level, className }: { level: HealthLevel; className?: string }) {
  const config = healthConfig[level] || healthConfig.green;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
        config.bg,
        config.text,
        className
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", config.dot)} />
      {config.label}
    </span>
  );
}

export function HealthDot({ level, className }: { level: HealthLevel; className?: string }) {
  const config = healthConfig[level] || healthConfig.green;

  return (
    <span
      className={cn("inline-block h-2.5 w-2.5 rounded-full", config.dot, className)}
      title={config.label}
    />
  );
}

export function computeRepoHealth(repo: {
  escalated_count?: number;
  pending_count?: number;
  has_conflicts?: boolean;
}): HealthLevel {
  if (repo.has_conflicts || (repo.escalated_count && repo.escalated_count > 0)) {
    return "red";
  }
  if (repo.pending_count && repo.pending_count > 0) {
    return "yellow";
  }
  return "green";
}
