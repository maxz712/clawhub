"use client";

import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import type { SecretRow as SecretRowType } from "@/lib/api";

export function SecretRow({ row, onDelete }: { row: SecretRowType; onDelete: (name: string) => void }) {
  return (
    <div className="flex items-center justify-between p-3 rounded border bg-card">
      <div>
        <code className="font-mono text-sm text-primary">{row.name}</code>
        <div className="text-xs text-muted-foreground font-mono">added {new Date(row.createdAt).toLocaleDateString()}</div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => onDelete(row.name)} aria-label={`Delete ${row.name}`}><Trash2 className="h-4 w-4" /></Button>
    </div>
  );
}
