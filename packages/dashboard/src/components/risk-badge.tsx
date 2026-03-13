"use client";

import { Badge } from "@/components/ui/badge";

const riskConfig: Record<string, { label: string; className: string }> = {
  low: {
    label: "Low Risk",
    className: "bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25",
  },
  medium: {
    label: "Medium Risk",
    className: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/25",
  },
  high: {
    label: "High Risk",
    className: "bg-orange-500/15 text-orange-400 border-orange-500/30 hover:bg-orange-500/25",
  },
  critical: {
    label: "Critical",
    className: "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25",
  },
};

export function RiskBadge({ level }: { level: string }) {
  const config = riskConfig[level] || {
    label: level,
    className: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  };

  return (
    <Badge variant="outline" className={config.className}>
      {config.label}
    </Badge>
  );
}
