"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type LoopStatus, type LoopPreset, type LoopCadence, type LoopInstallBody } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Infinity as InfinityIcon, Zap, CircleDot, Pause, ChevronDown, ChevronRight } from "lucide-react";

// One-click loop shapes. `roles` drives which custom-prompt fields show.
const PRESETS: { id: LoopPreset; name: string; flow: string; roles: { scout?: boolean; developer?: boolean; reviewer?: boolean } }[] = [
  { id: "full",       name: "Full loop",    flow: "scout → dev → reviewer → merge", roles: { scout: true, developer: true, reviewer: true } },
  { id: "dev-review", name: "Dev + Review", flow: "you file → dev → reviewer → merge", roles: { developer: true, reviewer: true } },
  { id: "scout-dev",  name: "Scout + Dev",  flow: "scout → dev → you review",       roles: { scout: true, developer: true } },
  { id: "scout",      name: "Scout only",   flow: "files issues on a schedule",     roles: { scout: true } },
  { id: "dev",        name: "Dev only",     flow: "builds your assigned issues",    roles: { developer: true } },
  { id: "review",     name: "Review only",  flow: "verifies every opened Change",   roles: { reviewer: true } },
];

// What each autonomy level ACTUALLY does — kept in step with the policy
// `applyAutonomyDial` writes (packages/api/src/services/loop.ts; its docblock is
// the behavioral spec). ONE source for the trigger label, the dropdown items, the
// explainer and the installed badge, so a level can never be described three
// different ways (#136: "Low (earned self-merge)" advertised a mechanism v3 had
// already retired from the merge gate, and the dial had no `low` branch at all).
const AUTONOMY_LEVELS = {
  review_only: {
    title: "Review only — humans merge",
    detail: "Agents open Changes and review them. Every merge waits for a human.",
  },
  low: {
    title: "Low — agent merges low-risk",
    detail: "The agent's own approval counts, so LOW-risk Changes merge without a human. Medium+ risk and sensitive paths (migrations, deploy, CI, policy) still require one.",
  },
  medium: {
    title: "Full — verified auto-merge",
    detail: "A verified end-to-end attestation stands in for the human approval up to medium risk, and the Change auto-merges. The RECOMMENDED human-only floor (policies, CI, deploy scripts) stays ON.",
  },
} as const;
type AutonomyLevel = keyof typeof AUTONOMY_LEVELS;

// The autonomous Loop (M8): compose an agent loop in one click. Pick a shape (which
// agents), a cadence, an autonomy level, and optional per-agent focus prompts.
export function LoopCard({ ns, repo, onChanged }: { ns: string; repo: string; onChanged?: () => void }) {
  const [status, setStatus] = useState<LoopStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState<LoopPreset>("full");
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("medium");
  const [cadence, setCadence] = useState<LoopCadence>("daily");
  const [devKind, setDevKind] = useState<"ui" | "code">("ui");
  const [scoutPrompt, setScoutPrompt] = useState("");
  const [devPrompt, setDevPrompt] = useState("");
  const [reviewPrompt, setReviewPrompt] = useState("");
  const [customize, setCustomize] = useState(false);
  const [platformKey, setPlatformKey] = useState(false);
  const [llmKey, setLlmKey] = useState("");
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
    try { await fn(); await load(); onChanged?.(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  function install() {
    const p = PRESETS.find(x => x.id === preset)!;
    const body: LoopInstallBody = { autonomy, preset, cadence };
    if (p.roles.developer) body.devKind = devKind;
    if (p.roles.scout && scoutPrompt.trim()) body.scout = { prompt: scoutPrompt.trim() };
    if (p.roles.developer && devPrompt.trim()) body.developer = { prompt: devPrompt.trim() };
    if (p.roles.reviewer && reviewPrompt.trim()) body.reviewer = { prompt: reviewPrompt.trim() };
    if (platformKey) body.keySource = "platform";
    else if (llmKey.trim()) body.llmApiKey = llmKey.trim();
    return act(() => api.installLoop(ns, repo, body).then(() => api.telemetry("loop_installed")));
  }

  if (!loaded) return null;
  const installed = !!status;
  const sel = PRESETS.find(x => x.id === preset)!;
  const ta = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono resize-y min-h-[52px] focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <InfinityIcon className="h-4 w-4 text-primary" />
          <CardTitle className="text-sm">Agent Loop</CardTitle>
          {installed && (
            <Badge variant="secondary" className="uppercase text-[9px]"
              title={AUTONOMY_LEVELS[status!.loop.autonomy as AutonomyLevel]?.detail}>
              {status!.loop.autonomy.replace("_", " ")}
            </Badge>
          )}
          {installed && status!.loop.status === "killed" && <Badge className="bg-amber-500/15 text-amber-300 border border-amber-400/30 uppercase text-[9px]">paused</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!installed ? (
          <>
            <p className="text-sm text-muted-foreground">
              Compose an agent loop in one click. Pick a shape, a cadence, and how much it can merge on its own.
            </p>

            {/* One-click preset grid */}
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map(p => {
                const active = preset === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPreset(p.id)}
                    className={`text-left rounded-md border px-2.5 py-2 transition-colors ${active ? "border-primary bg-primary/10" : "border-border hover:border-primary/50"}`}
                  >
                    <div className="text-xs font-medium flex items-center gap-1">
                      {active && <CircleDot className="h-3 w-3 text-primary" />}{p.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{p.flow}</div>
                  </button>
                );
              })}
            </div>

            <div className="flex items-end gap-2 flex-wrap">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Autonomy</label>
                <Select value={autonomy} onValueChange={v => setAutonomy(v as AutonomyLevel)}>
                  <SelectTrigger className="w-64"><SelectValue>{(v: string) => AUTONOMY_LEVELS[v as AutonomyLevel]?.title ?? v}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(AUTONOMY_LEVELS) as AutonomyLevel[]).map(k => (
                      <SelectItem key={k} value={k}>{AUTONOMY_LEVELS[k].title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(sel.roles.scout || sel.roles.developer) && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Cadence</label>
                  <Select value={cadence} onValueChange={v => setCadence(v as LoopCadence)}>
                    <SelectTrigger className="w-36"><SelectValue>{(v: string) => ({ daily: "Daily", twice_daily: "Twice daily", hourly: "Hourly", weekly: "Weekly" }[v] ?? v)}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="twice_daily">Twice daily</SelectItem>
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Every level explains itself, right under the control that sets it —
                an unexplained level is how a dead option goes unnoticed for two
                releases (#136). Same source as the dropdown labels. */}
            <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground leading-relaxed">{AUTONOMY_LEVELS[autonomy].detail}</p>
            </div>

            {/* Customize: per-agent focus prompts + dev flavor */}
            <button type="button" onClick={() => setCustomize(v => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {customize ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Customize instructions
            </button>
            {customize && (
              <div className="space-y-2 border-l-2 border-border pl-3">
                {sel.roles.scout && (
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Scout focus <span className="text-[10px]">(where + what to look for)</span></label>
                    <textarea className={ta} value={scoutPrompt} onChange={e => setScoutPrompt(e.target.value)}
                      placeholder="e.g. Focus on packages/api — find missing tests, error-handling gaps, and small refactors." />
                  </div>
                )}
                {sel.roles.developer && (
                  <>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Developer directive <span className="text-[10px]">(leave empty in a loop → it grabs the scout&apos;s issues)</span></label>
                      <textarea className={ta} value={devPrompt} onChange={e => setDevPrompt(e.target.value)}
                        placeholder="e.g. Prefer small, reversible changes. Always add a test." />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-muted-foreground">Developer kind</label>
                      <Select value={devKind} onValueChange={v => setDevKind(v as "ui" | "code")}>
                        <SelectTrigger className="w-40 h-7 text-xs"><SelectValue>{(v: string) => ({ ui: "UI (browser dev loop)", code: "Code (no app boot)" }[v] ?? v)}</SelectValue></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ui">UI (browser dev loop)</SelectItem>
                          <SelectItem value="code">Code (no app boot)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}
                {sel.roles.reviewer && (
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Reviewer focus</label>
                    <textarea className={ta} value={reviewPrompt} onChange={e => setReviewPrompt(e.target.value)}
                      placeholder="e.g. Pay special attention to auth + input validation." />
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy || (autonomy === "medium" && !sel.roles.reviewer)} onClick={install}>
                <Zap className="h-3.5 w-3.5 mr-1" /> Create loop
              </Button>
              <span className="text-[11px] text-muted-foreground">{sel.name} · {AUTONOMY_LEVELS[autonomy].title.toLowerCase()}</span>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input type="checkbox" className="accent-primary" checked={platformKey} onChange={e => setPlatformKey(e.target.checked)} />
              Zero-setup: run on ClawHub&apos;s metered inference (no key to paste — billed against your auto-created Loop budget)
            </label>
            {!platformKey && (
              <div className="space-y-1">
                <input
                  type="password"
                  value={llmKey}
                  onChange={e => setLlmKey(e.target.value)}
                  placeholder="LLM API key for the loop's agents (sealed at rest)"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p className="text-[11px] text-muted-foreground">
                  Bring-your-own key for every role this loop deploys. Leave blank ONLY if your runner reaches a local no-auth model — otherwise the loop&apos;s first run will fail.
                </p>
              </div>
            )}
            {autonomy === "medium" && !sel.roles.reviewer && (
              <p className="text-[11px] text-amber-400">Full autonomy needs a reviewer to verify + auto-merge — pick a shape that includes one.</p>
            )}
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
            {status!.spend && (status!.spend.reportedSpendCents30d > 0 || status!.spend.budgetMonthlyUsd != null) && (
              <p className="text-[11px] text-muted-foreground">
                Reported spend (30d): <span className="font-mono text-foreground">${(status!.spend.reportedSpendCents30d / 100).toFixed(2)}</span>
                {status!.spend.budgetMonthlyUsd != null && <> · budget <span className="font-mono text-foreground">${status!.spend.budgetMonthlyUsd.toFixed(2)}/mo</span></>}
                <span className="ml-1">(agent-reported — BYO keys)</span>
              </p>
            )}
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
