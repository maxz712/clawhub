"use client";

import { useEffect, useState } from "react";
import { api, type Repo, type StandingTrigger } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EGRESS_HELP } from "@/components/standing-agent-row";

const PROVIDERS = ["anthropic", "openrouter", "openai", "custom"] as const;
const TRIGGERS: StandingTrigger[] = ["continuous", "schedule", "event", "manual"];
const MODES = ["worker", "review", "triage", "reflect"] as const;
const EGRESS_POLICIES = ["none", "allowlist", "all"] as const;

const Req = () => <span className="text-destructive" title="Required"> *</span>;

interface AttachForm {
  name: string; image: string; command?: string; trigger: StandingTrigger;
  intervalSec: number; cron?: string; event?: string; mode: string; task: string;
  llmProvider: string; llmBaseUrl?: string; agentName: string; egressPolicy: string;
}

// Attach a standing agent. Either pinned to one repo (`fixedRepo`, from the
// per-repo Settings panel) OR with a repo picker (`repos`, from the Agents hub's
// "All repos" view) so creating a standing agent never requires drilling into a
// repo first.
export function AttachStandingAgentDialog({
  open, onOpenChange, onAttached, fixedRepo, repos,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAttached: () => void | Promise<void>;
  fixedRepo?: { ns: string; repo: string };
  repos?: Repo[];
}) {
  const [repoSlug, setRepoSlug] = useState<string>("");   // "ns/name" when picking
  const blank: AttachForm = {
    name: "", image: "", trigger: "continuous", intervalSec: 3600, mode: "worker", task: "",
    llmProvider: "anthropic", agentName: "", egressPolicy: "none",
  };
  const [f, setF] = useState<AttachForm>(blank);
  const [useReferenceImage, setUseReferenceImage] = useState(true);
  const [llmApiKey, setLlmApiKey] = useState("");
  const [egressHosts, setEgressHosts] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runnerSeen, setRunnerSeen] = useState<boolean | null>(null);
  const set = (p: Partial<AttachForm>) => setF(prev => ({ ...prev, ...p }));

  // Reset on each open; warn if no runner has ever connected (ticks would queue).
  useEffect(() => {
    if (!open) return;
    setF(blank); setRepoSlug(""); setUseReferenceImage(true); setLlmApiKey(""); setEgressHosts(""); setError(null);
    setRunnerSeen(null); api.runnerStatus().then(r => setRunnerSeen(r.everSeen)).catch(() => setRunnerSeen(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ns = fixedRepo ? fixedRepo.ns : repoSlug.split("/")[0];
  const repo = fixedRepo ? fixedRepo.repo : repoSlug.split("/")[1];
  const repoChosen = !!(ns && repo);
  const intervalValid = f.trigger !== "continuous" || f.intervalSec >= 60;

  async function save() {
    if (!repoChosen) { setError("Pick a repo to attach this agent to."); return; }
    setBusy(true); setError(null);
    try {
      const command = f.command?.trim() ? f.command : undefined;
      const egressAllowedHosts = f.egressPolicy === "allowlist"
        ? egressHosts.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) : [];
      const image = useReferenceImage ? undefined : f.image;
      await api.createStandingAgent(ns!, repo!, { ...f, image, command, egressAllowedHosts, llmApiKey: llmApiKey || undefined });
      onOpenChange(false);
      await onAttached();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const submitDisabled = busy || !repoChosen || !f.name.trim() || !f.agentName.trim() || (!useReferenceImage && !f.image.trim()) || !intervalValid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Attach a standing agent{fixedRepo ? ` to ${fixedRepo.ns}/${fixedRepo.repo}` : ""}</DialogTitle></DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {runnerSeen === false && (
          <Alert className="border-yellow-500/40">
            <AlertDescription className="text-xs text-yellow-200">No CI runner has connected yet — the agent will attach, but its runs will queue until a runner is online.</AlertDescription>
          </Alert>
        )}
        <div className="space-y-3">
          {!fixedRepo && (
            <div>
              <Label>Repo<Req /></Label>
              <Select value={repoSlug} onValueChange={v => { setRepoSlug(v ?? ""); if (!f.agentName) set({ agentName: `${(v ?? "").split("/")[1] ?? "repo"}-bot` }); }}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Pick a repo to attach to" /></SelectTrigger>
                <SelectContent>
                  {(repos ?? []).map(r => { const slug = `${r.namespaceName}/${r.name}`; return <SelectItem key={r.id} value={slug}>{slug}</SelectItem>; })}
                </SelectContent>
              </Select>
            </div>
          )}
          <div><Label>Name<Req /></Label><Input value={f.name} onChange={e => set({ name: e.target.value })} placeholder="nightly-maintainer" /></div>
          <div className="rounded-md border border-border p-3 space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={useReferenceImage} onChange={e => setUseReferenceImage(e.target.checked)} />
              <span className="text-sm">
                <span className="font-medium">Use the built-in reference harness</span>
                <span className="block text-xs text-muted-foreground mt-0.5">Claude Code + a browser (Playwright/Chromium) baked in — nothing to build. Just bring an LLM key below and deploy.</span>
              </span>
            </label>
            {!useReferenceImage && (
              <div>
                <Label>Container image<Req /></Label>
                <Input className="font-mono" value={f.image} onChange={e => set({ image: e.target.value })} placeholder="ghcr.io/you/claude-harness:latest" />
                <p className="text-xs text-muted-foreground mt-1">Your agent image. It receives <code className="font-mono">CLAWHUB_TOKEN</code>, <code className="font-mono">CLAWHUB_TASK</code>, and your LLM key as env, runs in the cloned repo, and pushes Changes.</p>
              </div>
            )}
          </div>
          <div>
            <Label>Command override (optional)</Label>
            <Input className="font-mono" value={f.command ?? ""} onChange={e => set({ command: e.target.value })} placeholder="leave blank to use the image entrypoint" />
          </div>
          <div>
            <Label>Trigger</Label>
            <Select value={f.trigger} onValueChange={v => set({ trigger: v as StandingTrigger })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{TRIGGERS.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {f.trigger === "continuous" && (
            <div>
              <Label>Interval (seconds, min 60)</Label>
              <Input type="number" min={60} value={f.intervalSec} onChange={e => set({ intervalSec: Number(e.target.value) })} />
              {!intervalValid && <p className="text-xs text-destructive mt-1">Interval must be at least 60 seconds.</p>}
            </div>
          )}
          {f.trigger === "schedule" && <div><Label>Cron (5-field, UTC)</Label><Input className="font-mono" value={f.cron ?? ""} onChange={e => set({ cron: e.target.value })} placeholder="0 9 * * 1" /></div>}
          {f.trigger === "event" && <div><Label>Event type</Label><Input className="font-mono" value={f.event ?? ""} onChange={e => set({ event: e.target.value })} placeholder="change.merged" /></div>}
          <div>
            <Label>Mode</Label>
            <Select value={f.mode} onValueChange={v => set({ mode: v as string })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{MODES.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Injected as <code className="font-mono">CLAWHUB_MODE</code>. worker/review open Changes; reflect distills memories into conventions.</p>
          </div>
          <div><Label>Task / instructions</Label><Textarea value={f.task} onChange={e => set({ task: e.target.value })} placeholder="Keep deps current and tests green; open one small Change at a time." /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            <p className="text-xs text-muted-foreground mt-1">Stored sealed (libsodium); injected into your container only at run time. Leave blank for a local no-auth model. ClawHub never does inference — this is <strong>your</strong> key.</p>
          </div>
          <div>
            <Label>Network access (egress)</Label>
            <Select value={f.egressPolicy} onValueChange={v => set({ egressPolicy: v as string })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{EGRESS_POLICIES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">{EGRESS_HELP[f.egressPolicy]}</p>
            {f.egressPolicy === "allowlist" && (
              <Textarea className="font-mono mt-2" value={egressHosts} onChange={e => setEgressHosts(e.target.value)} placeholder={"example.com\n*.staging.test\napi.thirdparty.io"} rows={3} />
            )}
          </div>
          <div>
            <Label>Agent identity<Req /></Label>
            <Input value={f.agentName} onChange={e => set({ agentName: e.target.value })} placeholder="repo-bot" />
            <p className="text-xs text-muted-foreground mt-1">A dedicated agent the harness pushes as (created + granted writer on this repo).</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={submitDisabled}>{busy ? "Attaching…" : "Attach"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
