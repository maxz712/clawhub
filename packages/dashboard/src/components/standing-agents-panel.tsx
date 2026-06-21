"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type StandingAgent, type StandingTrigger } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Bot, Play, Pause, Trash2, Plus, AlertTriangle, CheckCircle2 } from "lucide-react";

const PROVIDERS = ["anthropic", "openrouter", "openai", "custom"] as const;
const TRIGGERS: StandingTrigger[] = ["continuous", "schedule", "event", "manual"];
const STANDING_DOCS = "https://useclawhub.com/docs/standing-agents";

// Robustness/cost fields the API may attach to a standing agent but that aren't
// (yet) in the shared StandingAgent type. Rendered only when present, so this is
// a forward-compatible, non-breaking read.
type StandingAgentExtra = StandingAgent & {
  consecutiveFailures?: number;
  circuitBreakerMax?: number;
  nextEligibleAt?: string | null;
  spendCents?: number;
  monthCostCents?: number;
  budgetCents?: number | null;
};

function triggerLabel(s: StandingAgent): string {
  switch (s.trigger) {
    case "continuous": return `continuous · every ${s.intervalSec}s`;
    case "schedule": return `schedule · ${s.cron ?? "?"} (UTC)`;
    case "event": return `event · ${s.event ?? "?"}`;
    default: return "manual";
  }
}

// "4m ago", "2h ago" — compact relative time for last-run display.
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

// An auto-paused agent is one the circuit breaker tripped: it errored AND is now
// disabled. A human pause leaves status untouched (idle/running) but disabled.
function isAutoPaused(s: StandingAgent): boolean {
  return !s.enabled && s.status === "error";
}

// Friendly explanation for a 409 refusal. The API returns {ok:false,reason},
// but the shared client surfaces it as a 409 ApiError, so we explain the
// possible causes rather than a bare "Conflict".
const REFUSAL_MESSAGE =
  "Run refused — the agent is rate-capped, over budget, already running, or killed. Check its state below and try again shortly.";

export function StandingAgentsPanel({ ns, repo }: { ns: string; repo: string }) {
  const [rows, setRows] = useState<StandingAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Per-agent run feedback: "running" while dispatching, then a queued/refusal note.
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [runNote, setRunNote] = useState<Record<string, { ok: boolean; text: string }>>({});

  async function load() {
    try { const r = await api.listStandingAgents(ns, repo); setRows(r.standingAgents); setError(null); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [ns, repo]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  }

  async function runNow(id: string) {
    setRunning(s => ({ ...s, [id]: true }));
    setRunNote(s => { const n = { ...s }; delete n[id]; return n; });
    try {
      const r = await api.runStandingAgent(ns, repo, id);
      // 2xx path. The route returns {ok:false,reason} only as a 409 (thrown
      // below), so a resolved value here is a successful queue.
      if (r.ok === false) {
        setRunNote(s => ({ ...s, [id]: { ok: false, text: refusalText(r.reason) } }));
      } else {
        setRunNote(s => ({ ...s, [id]: { ok: true, text: "Queued" } }));
      }
      await load();
    } catch (e) {
      // A 409 is a governance refusal (rate-capped / over-budget / in-flight /
      // killed). The shared client drops the reason body, so explain the causes.
      if (e instanceof ApiError && e.status === 409) {
        setRunNote(s => ({ ...s, [id]: { ok: false, text: REFUSAL_MESSAGE } }));
      } else {
        setRunNote(s => ({ ...s, [id]: { ok: false, text: (e as Error).message } }));
      }
    } finally {
      setRunning(s => ({ ...s, [id]: false }));
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium"><Bot className="h-4 w-4 text-primary" /> Standing agents</div>
        <p className="text-xs text-muted-foreground">
          Bring your own AI — a Claude subscription proxy, an Anthropic / OpenRouter key, or a local model — and ClawHub runs it 24/7
          in this repo to open and review Changes. The model runs in <strong>your</strong> container with <strong>your</strong> key; ClawHub
          never does inference. Every Change it opens still goes through your merge policy. <a className="text-primary underline" href={STANDING_DOCS} target="_blank" rel="noreferrer">Learn more</a>.
        </p>
        <p className="text-xs text-muted-foreground">
          <strong>Prerequisite:</strong> a CI runner must be connected to this instance to execute these — without one, ticks queue but never run.
        </p>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="flex justify-between items-center">
        <div className="text-sm text-muted-foreground">{rows ? `${rows.length} attached` : "Loading…"}</div>
        <Button size="sm" className="gap-2" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Attach agent</Button>
      </div>

      {rows && rows.length === 0 && <div className="text-muted-foreground text-sm">No standing agents attached.</div>}

      {rows?.map(sa => {
        const s = sa as StandingAgentExtra;
        const autoPaused = isAutoPaused(s);
        const note = runNote[s.id];
        const failures = s.consecutiveFailures;
        const breakerMax = s.circuitBreakerMax;
        const spendCents = s.spendCents ?? s.monthCostCents;
        return (
          <div key={s.id} className="rounded-lg border bg-card p-4 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{s.name}</span>
                  {autoPaused ? (
                    <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> auto-paused</Badge>
                  ) : !s.enabled ? (
                    <Badge variant="secondary">paused</Badge>
                  ) : (
                    <Badge variant="default" className="bg-primary/15 text-primary border border-primary/30">{s.status}</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1">{triggerLabel(s)} · <span className="font-mono">{s.llmProvider}</span></div>
                <code className="font-mono text-xs text-muted-foreground truncate block mt-1">{s.image}</code>

                {/* Robustness + cost line — only the fields the payload carries. */}
                <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mt-1">
                  {s.lastRunAt && <span>last run {relTime(s.lastRunAt)}</span>}
                  {typeof failures === "number" && failures > 0 && (
                    <span className="text-destructive">· {failures}{typeof breakerMax === "number" ? `/${breakerMax}` : ""} failures</span>
                  )}
                  {s.nextEligibleAt && <span>· next eligible {relTime(s.nextEligibleAt)}</span>}
                  {typeof spendCents === "number" && (
                    <span>· ${(spendCents / 100).toFixed(2)}{typeof s.budgetCents === "number" && s.budgetCents ? ` / $${(s.budgetCents / 100).toFixed(2)}` : ""}</span>
                  )}
                </div>

                {autoPaused && (
                  <div className="text-xs text-destructive mt-1">Circuit breaker tripped after repeated failures — resume to clear it once the cause is fixed.</div>
                )}
                {s.lastError && <div className="flex items-center gap-1 text-xs text-destructive mt-1"><AlertTriangle className="h-3 w-3" /> {s.lastError}</div>}
                {note && (
                  <div className={`flex items-center gap-1 text-xs mt-1 ${note.ok ? "text-primary" : "text-destructive"}`}>
                    {note.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />} {note.text}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="sm" title="Run now" disabled={running[s.id]} onClick={() => runNow(s.id)}><Play className="h-4 w-4" /></Button>
                <Button variant="ghost" size="sm" title={s.enabled ? "Pause" : autoPaused ? "Resume (clear breaker)" : "Resume"} onClick={() => act(() => api.updateStandingAgent(ns, repo, s.id, { enabled: !s.enabled }))}>
                  {s.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 text-primary" />}
                </Button>
                <Button variant="ghost" size="sm" title="Remove" onClick={() => act(() => api.deleteStandingAgent(ns, repo, s.id))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          </div>
        );
      })}

      <AttachDialog ns={ns} repo={repo} open={open} onOpenChange={setOpen} onAttached={load} />
    </div>
  );
}

// Map a returned {ok:false,reason} (if the client ever surfaces it) to text.
function refusalText(reason?: string): string {
  switch (reason) {
    case "rate_capped": return "Run refused — rate-capped. Try again shortly.";
    case "over_budget": return "Run refused — over its cost budget.";
    case "in_flight": return "Run refused — a run is already in flight.";
    case "killed": return "Run refused — the agent's kill switch is engaged.";
    case "disabled": return "Run refused — the agent is paused.";
    case "unresolved": return "Run refused — the agent could not be resolved.";
    default: return REFUSAL_MESSAGE;
  }
}

interface AttachForm {
  name: string; image: string; command?: string; trigger: StandingTrigger;
  intervalSec: number; cron?: string; event?: string; task: string;
  llmProvider: string; llmBaseUrl?: string; agentName: string;
}

function AttachDialog({ ns, repo, open, onOpenChange, onAttached }: { ns: string; repo: string; open: boolean; onOpenChange: (v: boolean) => void; onAttached: () => Promise<void> }) {
  const [f, setF] = useState<AttachForm>({
    name: "", image: "", trigger: "continuous", intervalSec: 3600, task: "", llmProvider: "anthropic", agentName: `${repo}-bot`,
  });
  const [llmApiKey, setLlmApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<AttachForm>) => setF(prev => ({ ...prev, ...p }));

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.createStandingAgent(ns, repo, { ...f, llmApiKey: llmApiKey || undefined });
      onOpenChange(false);
      setF({ name: "", image: "", trigger: "continuous", intervalSec: 3600, task: "", llmProvider: "anthropic", agentName: `${repo}-bot` });
      setLlmApiKey("");
      await onAttached();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Attach a standing agent</DialogTitle></DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={f.name} onChange={e => set({ name: e.target.value })} placeholder="nightly-maintainer" /></div>
          <div>
            <Label>Container image</Label>
            <Input className="font-mono" value={f.image} onChange={e => set({ image: e.target.value })} placeholder="ghcr.io/you/claude-harness:latest" />
            <p className="text-xs text-muted-foreground mt-1">Your agent image. It receives <code className="font-mono">CLAWHUB_TOKEN</code>, <code className="font-mono">CLAWHUB_TASK</code>, and your LLM key as env, runs in the cloned repo, and pushes Changes.</p>
          </div>
          <div>
            <Label>Trigger</Label>
            <Select value={f.trigger} onValueChange={v => set({ trigger: v as StandingTrigger })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{TRIGGERS.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {f.trigger === "continuous" && <div><Label>Interval (seconds, min 60)</Label><Input type="number" value={f.intervalSec} onChange={e => set({ intervalSec: Number(e.target.value) })} /></div>}
          {f.trigger === "schedule" && <div><Label>Cron (5-field, UTC)</Label><Input className="font-mono" value={f.cron ?? ""} onChange={e => set({ cron: e.target.value })} placeholder="0 9 * * 1" /></div>}
          {f.trigger === "event" && <div><Label>Event type</Label><Input className="font-mono" value={f.event ?? ""} onChange={e => set({ event: e.target.value })} placeholder="change.merged" /></div>}
          <div><Label>Task / instructions</Label><Textarea value={f.task} onChange={e => set({ task: e.target.value })} placeholder="Keep deps current and tests green; open one small Change at a time." /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>LLM provider</Label>
              <Select value={f.llmProvider} onValueChange={v => set({ llmProvider: v as string })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PROVIDERS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Base URL (optional)</Label><Input className="font-mono" value={f.llmBaseUrl ?? ""} onChange={e => set({ llmBaseUrl: e.target.value })} placeholder="proxy / local model" /></div>
          </div>
          <div>
            <Label>LLM API key</Label>
            <Input type="password" value={llmApiKey} onChange={e => setLlmApiKey(e.target.value)} placeholder="sealed on submit · never shown again" />
            <p className="text-xs text-muted-foreground mt-1">Stored sealed (libsodium); injected into your container only at run time. Leave blank for a local no-auth model.</p>
          </div>
          <div>
            <Label>Agent identity</Label>
            <Input value={f.agentName ?? ""} onChange={e => set({ agentName: e.target.value })} placeholder={`${repo}-bot`} />
            <p className="text-xs text-muted-foreground mt-1">A dedicated agent the harness pushes as (created + granted writer on this repo).</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={busy || !f.name || !f.image || !f.agentName}>{busy ? "Attaching…" : "Attach"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
