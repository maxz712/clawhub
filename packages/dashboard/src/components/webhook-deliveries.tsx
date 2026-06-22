"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type WebhookDeliveryRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RotateCw } from "lucide-react";

const STATUS_STYLE: Record<string, string> = {
  delivered: "bg-primary/15 text-primary border-primary/30",
  pending: "bg-muted text-muted-foreground",
  retrying: "bg-yellow-400/15 text-yellow-500 border-yellow-400/30",
  dead: "bg-destructive/15 text-destructive border-destructive/30",
};

const FILTERS = ["all", "delivered", "retrying", "dead"] as const;

/**
 * Per-webhook delivery log: status / attempts / last error / timestamps, a
 * Replay button per row, and a status filter (incl. the `dead` DLQ). Wires the
 * already-existing api.listWebhookDeliveries + api.replayDelivery.
 */
export function WebhookDeliveriesPanel({ ns, repo, webhookId }: { ns: string; repo: string; webhookId: string }) {
  const [rows, setRows] = useState<WebhookDeliveryRow[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows((await api.listWebhookDeliveries(ns, repo, webhookId, filter === "all" ? undefined : filter)).deliveries); }
    catch (e) { setError((e as Error).message); }
  }, [ns, repo, webhookId, filter]);

  useEffect(() => { void load(); }, [load]);

  async function replay(id: string) {
    setBusy(id);
    try { await api.replayDelivery(ns, repo, webhookId, id); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-2 border-t pt-3 mt-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        {FILTERS.map(f => (
          <Button key={f} size="sm" variant={filter === f ? "secondary" : "ghost"} className="h-6 px-2 text-xs capitalize" onClick={() => setFilter(f)}>
            {f === "dead" ? "Dead-letter" : f}
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs ml-auto gap-1" onClick={() => void load()}><RotateCw className="h-3 w-3" /> Refresh</Button>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {rows === null ? (
        <div className="text-xs text-muted-foreground">Loading deliveries…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">No {filter === "all" ? "" : `${filter} `}deliveries.</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map(d => (
            <div key={d.id} className="rounded border bg-background/50 p-2 text-xs space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={`text-[10px] capitalize ${STATUS_STYLE[d.status] ?? ""}`}>{d.status}</Badge>
                <span className="font-mono text-muted-foreground">{(d.payload as { type?: string })?.type ?? "event"}</span>
                <span className="text-muted-foreground">· {d.attempts} attempt{d.attempts === 1 ? "" : "s"}</span>
                <span className="text-muted-foreground ml-auto">{new Date(d.createdAt).toLocaleString()}</span>
                {(d.status === "dead" || d.status === "retrying") && (
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] gap-1" disabled={busy === d.id} onClick={() => void replay(d.id)}>
                    <RotateCw className="h-3 w-3" /> {busy === d.id ? "…" : "Replay"}
                  </Button>
                )}
              </div>
              {d.lastError && <div className="text-destructive font-mono break-all">{d.lastError}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
