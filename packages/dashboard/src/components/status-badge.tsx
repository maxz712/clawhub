"use client";

import { Badge } from "@/components/ui/badge";

const statusConfig: Record<string, { label: string; className: string }> = {
  pending: {
    label: "Pending",
    className: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/25",
  },
  approved: {
    label: "Approved",
    className: "bg-blue-500/15 text-blue-400 border-blue-500/30 hover:bg-blue-500/25",
  },
  merged: {
    label: "Merged",
    className: "bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25",
  },
  rejected: {
    label: "Rejected",
    className: "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25",
  },
  rolled_back: {
    label: "Rolled Back",
    className: "bg-gray-500/15 text-gray-400 border-gray-500/30 hover:bg-gray-500/25",
  },
};

export function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] || {
    label: status,
    className: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  };

  return (
    <Badge variant="outline" className={config.className}>
      {config.label}
    </Badge>
  );
}
