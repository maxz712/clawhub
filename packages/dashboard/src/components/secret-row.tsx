"use client";

import { Button } from "@/components/ui/button";
import { Trash2, Lock } from "lucide-react";
import type { SecretRow as SecretRowType } from "@/lib/api";

// Renders a secret's NAME + created-at + delete only. The plaintext value is
// sealed at rest and never returned by the API, so there is nothing to reveal
// here by design. Delete is confirmed so a stray click can't drop a CI secret.
export function SecretRow({ row, onDelete }: { row: SecretRowType; onDelete: (name: string) => void }) {
  function confirmDelete() {
    if (typeof window !== "undefined" && !window.confirm(`Delete secret "${row.name}"? CI pipelines that use it will break until it's re-added.`)) return;
    onDelete(row.name);
  }
  return (
    <div className="flex items-center justify-between p-3 rounded border bg-card">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <code className="font-mono text-sm text-primary truncate">{row.name}</code>
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Lock className="h-3 w-3" /> CI-only, sealed
          </span>
        </div>
        <div className="text-xs text-muted-foreground font-mono">added {new Date(row.createdAt).toLocaleDateString()}</div>
      </div>
      <Button variant="ghost" size="sm" onClick={confirmDelete} aria-label={`Delete ${row.name}`}><Trash2 className="h-4 w-4" /></Button>
    </div>
  );
}
