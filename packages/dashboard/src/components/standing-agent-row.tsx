"use client";

import { useState } from "react";
import { api, ApiError, type StandingAgent } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Play, Pause, Power, Trash2, AlertTriangle, CheckCircle2, Skull } from "lucide-react";

export const EGRESS_HELP: Record<string, string> = {
  none: "Infra only — reaches ClawHub + your LLM, plus apps it starts on localhost. Nothing else on the internet.",
  allowlist: "Infra + the hosts you list. Everything else is blocked.",
  all: "Any public host. Private/internal addresses (DBs, cloud metadata) stay blocked in every mode.",
};

export function triggerLabel(s: StandingAgent): string {
  switch (s.trigger) {
    case "continuous": return `continuous · every ${s.intervalSec}s`;
    case "schedule": return `schedule · ${s.cron ?? "?"} (UTC)`;
    case "event": return `event · ${s.event ?? "?"}`;
    default: return "manual";
  }
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function refusalText(reason?: string): string {
  switch (reason) {
    case "rate_capped": return "Run refused — rate-capped. Try again shortly.";
    case "over_budget": return "Run refused — over its cost budget.";
    case "in_flight": return "Run refused — a run is already in flight.";
    case "killed": return "Run refused — the agent's kill switch is engaged.";
    case "disabled": return "Run refused — the agent is paused.";
    case "unresolved": return "Run refused — the agent could not be resolved.";
    default: return "Run refused — the agent is rate-capped, over budget, already running, or killed.";
  }
}

// The real circuit-breaker (auto-pause) state: paused AND the failure counter has
// hit the breaker max — NOT merely "paused + last status was error" (which also
// matches a human pausing a previously-errored agent).
function isCircuitBroken(s: StandingAgent): boolean {
  return !s.enabled && (s.consecutiveFailures ?? 0) >= (s.circuitBreakerMax ?? Infinity);
}

// One status → {label, badge, note} map, so paused/idle/running/auto-paused/
// killed/error read consistently everywhere. Colour always matches the word.
function statusInfo(s: StandingAgent): { label: string; node: React.ReactNode; note?: string } {
  if (s.killed) return { label: "killed", node: <Badge variant="destructive" className="gap-1"><Skull className="h-3 w-3" /> killed</Badge>, note: "Kill switch engaged — release it from the agent's Governance tab to resume." };
  if (isCircuitBroken(s)) return { label: "auto-paused", node: <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> auto-paused</Badge>, note: "Circuit breaker tripped after repeated failures — Resume to clear it once the cause is fixed." };
  if (!s.enabled) return { label: "paused", node: <Badge variant="secondary">paused</Badge> };
  if (s.status === "running") return { label: "running", node: <Badge className="gap-1.5 bg-primary/15 text-primary border border-primary/30"><span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" /> running</Badge> };
  if (s.status === "error") return { label: "error", node: <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> error</Badge> };
  return { label: "idle", node: <Badge variant="secondary">idle</Badge> };
}

const fmtUsd = (c: number) => `$${(c / 100).toFixed(2)}`;

// One shared row for a standing agent — used by the per-repo panel AND the
// cross-repo hub roster, so status, controls, metadata, and run feedback look
// and behave identically. Controls are LABELED (Run / Pause|Resume / Remove) to
// kill the old twin-play-triangle ambiguity; Run is disabled when the agent
// can't run (paused or killed).
export function StandingAgentRow({ ns, repo, agent: s, onChanged }: { ns: string; repo: string; agent: StandingAgent; onChanged: () => void | Promise<void> }) {
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const st = statusInfo(s);
  const canRun = s.enabled && !s.killed;
  const spendCents = s.spendCents ?? s.monthCostCents;

  async function runNow() {
    setRunning(true); setNote(null);
    try {
      const r = await api.runStandingAgent(ns, repo, s.id);
      setNote(r.ok === false ? { ok: false, text: refusalText(r.reason) } : { ok: true, text: "Queued" });
      await onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNote({ ok: false, text: refusalText((e.body as { reason?: string } | undefined)?.reason) });
      else setNote({ ok: false, text: (e as Error).message });
    } finally { setRunning(false); }
  }
  async function toggle() {
    setBusy(true); setNote(null);
    try { await api.updateStandingAgent(ns, repo, s.id, { enabled: !s.enabled }); await onChanged(); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await api.deleteStandingAgent(ns, repo, s.id); setConfirmRemove(false); await onChanged(); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium truncate">{s.name}</span>
          {st.node}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
          <span>{triggerLabel(s)} · <span className="font-mono">{s.mode ?? "worker"}</span> · <span className="font-mono">{s.llmProvider}</span></span>
          {s.egressPolicy && (
            <span title={EGRESS_HELP[s.egressPolicy]}
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider border ${s.egressPolicy === "all" ? "border-orange-500/40 text-orange-400" : s.egressPolicy === "allowlist" ? "border-primary/30 text-primary" : "border-border text-muted-foreground"}`}>
              egress: {s.egressPolicy}{s.egressPolicy === "allowlist" && s.egressAllowedHosts?.length ? ` (${s.egressAllowedHosts.length})` : ""}
            </span>
          )}
        </div>
        <code className="font-mono text-xs text-muted-foreground truncate block">{s.image}</code>
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
          {s.lastRunAt && <span>last run {relTime(s.lastRunAt)}</span>}
          {typeof s.consecutiveFailures === "number" && s.consecutiveFailures > 0 && (
            <span className="text-destructive">· {s.consecutiveFailures}{typeof s.circuitBreakerMax === "number" ? `/${s.circuitBreakerMax}` : ""} failures</span>
          )}
          {s.nextEligibleAt && <span>· next eligible {relTime(s.nextEligibleAt)}</span>}
          {typeof spendCents === "number" && (
            <span title="LLM spend this month (self-reported by the agent) / budget">· {fmtUsd(spendCents)}{typeof s.budgetCents === "number" && s.budgetCents ? ` / ${fmtUsd(s.budgetCents)}` : ""} spend</span>
          )}
        </div>
        {st.note && <div className="text-xs text-destructive">{st.note}</div>}
        {s.lastError && <div className="flex items-center gap-1 text-xs text-destructive"><AlertTriangle className="h-3 w-3" /> {s.lastError}</div>}
        {note && (
          <div className={`flex items-center gap-1 text-xs ${note.ok ? "text-primary" : "text-destructive"}`}>
            {note.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />} {note.text}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button variant="outline" size="sm" className="gap-1.5" disabled={!canRun || running} title={canRun ? "Run once now" : s.killed ? "Killed — release the kill switch first" : "Paused — resume to run"} onClick={runNow}>
          <Play className="h-3.5 w-3.5" /> Run
        </Button>
        <Button variant="ghost" size="sm" className="gap-1.5" disabled={busy || s.killed} onClick={toggle}
          title={s.enabled ? "Pause this agent" : "Resume this agent"}>
          {s.enabled ? <><Pause className="h-3.5 w-3.5" /> Pause</> : <><Power className="h-3.5 w-3.5" /> Resume</>}
        </Button>
        <Button variant="ghost" size="icon-sm" className="size-8 text-muted-foreground hover:text-destructive" title="Remove" aria-label={`Remove ${s.name}`} onClick={() => setConfirmRemove(true)}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={confirmRemove} onOpenChange={v => { if (!v && !busy) setConfirmRemove(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Remove standing agent “{s.name}”?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Detaches it from <code className="font-mono">{ns}/{repo}</code> and stops its scheduled runs. This can&apos;t be undone (you can re-attach later).</p>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={remove}>{busy ? "Removing…" : "Remove"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
