"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type LoopStatus } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Infinity as InfinityIcon, Zap, CircleDot, Pause } from "lucide-react";

// The autonomous Loop (M8): install/kill/resume a developer + verified-reviewer
// bundle with a policy dial. File an issue → developer ships → verifier attests →
// auto-merge behind the floor (at medium autonomy).
export function LoopCard({ ns, repo }: { ns: string; repo: string }) {
  const [status, setStatus] = useState<LoopStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [autonomy, setAutonomy] = useState<"review_only" | "low" | "medium">("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const r = await api.getLoop(ns, repo); setStatus(r.status); }
    catch (e) { setError((e as Error).message); }
    finally { setLoaded(true); }
  }, [ns, repo]);
  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (!loaded) return null;
  const installed = !!status;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <InfinityIcon className="h-4 w-4 text-primary" />
          <CardTitle className="text-sm">Autonomous Loop</CardTitle>
          {installed && <Badge variant="secondary" className="uppercase text-[9px]">{status!.loop.autonomy.replace("_", " ")}</Badge>}
          {installed && status!.loop.status === "killed" && <Badge className="bg-amber-500/15 text-amber-300 border border-amber-400/30 uppercase text-[9px]">paused</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!installed ? (
          <>
            <p className="text-sm text-muted-foreground">
              A developer + an independent verified-reviewer, packaged. File an issue and it ships — the developer builds it, the verifier attests it, and it auto-merges behind the floor.
            </p>
            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Autonomy</label>
                <Select value={autonomy} onValueChange={v => setAutonomy(v as typeof autonomy)}>
                  <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="review_only">Review only (humans merge)</SelectItem>
                    <SelectItem value="low">Low (earned self-merge)</SelectItem>
                    <SelectItem value="medium">Medium (verified auto-merge)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" disabled={busy} onClick={() => act(() => api.installLoop(ns, repo, { autonomy }).then(() => api.telemetry("loop_installed")))}>
                <Zap className="h-3.5 w-3.5 mr-1" /> Install Loop
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">Medium autonomy keeps the RECOMMENDED human-only floor (policies, CI, deploy scripts) ON. BYO-key in v1.</p>
          </>
        ) : (
          <>
            <ul className="space-y-1.5">
              {status!.agents.map(a => (
                <li key={a.id} className="flex items-center gap-2 text-sm">
                  {a.enabled
                    ? (a.consecutiveFailures > 0 ? <CircleDot className="h-3.5 w-3.5 text-amber-400" /> : <CircleDot className="h-3.5 w-3.5 text-primary" />)
                    : <Pause className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="font-mono text-xs">{a.name}</span>
                  <span className="text-xs text-muted-foreground">{a.status}{a.consecutiveFailures > 0 ? ` · ${a.consecutiveFailures} fails` : ""}</span>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              {status!.loop.status === "active"
                ? <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => api.killLoop(ns, repo))}>Pause</Button>
                : <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => api.resumeLoop(ns, repo))}>Resume</Button>}
              <Button variant="ghost" size="sm" className="text-destructive" disabled={busy}
                onClick={() => { if (confirm("Uninstall the Loop? Its agents are removed and the merge policy reverts if unchanged.")) act(() => api.uninstallLoop(ns, repo)); }}>
                Uninstall
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
