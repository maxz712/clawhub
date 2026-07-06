"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const AUTONOMY_NOTE =
  "Earned autonomy lets a template's agent self-merge ONLY its own LOW-risk work, and only after it has a track record + clears the quality bar. It never bypasses sensitive-path, medium+/high-risk, or human-required gates.";

type Capability = "worker" | "reviewer" | "triager" | "specialist";
type Trigger = "continuous" | "manual" | "schedule" | "event";
type TrustTier = "untrusted" | "sandbox" | "standard" | "trusted";
type LlmProvider = "anthropic" | "openrouter" | "openai" | "custom";

/**
 * Full custom agent-template authoring form (the legacy `agent_roles` — v3
 * renames them "Agent Templates"; "Role" now means access control only). Used
 * for both org-owned templates (pass `orgId`) and the caller's personal
 * templates (omit `orgId`). Exposes the complete createRole field set; submit
 * seals the LLM key and creates the template. The API methods keep their
 * legacy `role` names.
 */
export function CustomTemplateDialog({
  open, onOpenChange, orgId, onCreated, onError,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orgId?: string;
  onCreated: (name: string) => void | Promise<void>;
  onError: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [capability, setCapability] = useState<Capability>("worker");
  const [specialization, setSpecialization] = useState("");
  const [image, setImage] = useState("");
  const [task, setTask] = useState("");
  const [trigger, setTrigger] = useState<Trigger>("continuous");
  const [cron, setCron] = useState("");
  const [event, setEvent] = useState("");
  const [minTrustTier, setMinTrustTier] = useState<TrustTier>("sandbox");
  const [llmProvider, setLlmProvider] = useState<LlmProvider>("anthropic");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [earnedAutonomy, setEarnedAutonomy] = useState(false);
  const [busy, setBusy] = useState(false);

  function reset() {
    setName(""); setCapability("worker"); setSpecialization(""); setImage(""); setTask("");
    setTrigger("continuous"); setCron(""); setEvent(""); setMinTrustTier("sandbox");
    setLlmProvider("anthropic"); setLlmApiKey(""); setEarnedAutonomy(false);
  }

  async function go() {
    if (!name.trim()) { onError("Name is required."); return; }
    if (trigger === "schedule" && !cron.trim()) { onError("A schedule trigger needs a cron expression."); return; }
    if (trigger === "event" && !event.trim()) { onError("An event trigger needs an event name."); return; }
    setBusy(true);
    try {
      await api.createRole({
        ...(orgId ? { org: orgId } : {}),
        name: name.trim(),
        capability,
        specialization: specialization.trim() || undefined,
        image: image.trim() || undefined,
        task: task.trim() || undefined,
        trigger,
        cron: trigger === "schedule" ? cron.trim() : undefined,
        event: trigger === "event" ? event.trim() : undefined,
        minTrustTier,
        llmProvider,
        llmApiKey: llmApiKey || undefined,
        earnedAutonomy,
      });
      const created = name.trim();
      reset();
      onOpenChange(false);
      await onCreated(created);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!busy) { onOpenChange(v); if (!v) reset(); } }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Create custom template</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            A template is the deployable unit of agent. Runs in your container with your key; ClawHub never does inference.
          </p>
          <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. nightly-refactorer" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Capability</Label>
              <Select value={capability} onValueChange={v => setCapability((v ?? "worker") as Capability)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="worker">worker</SelectItem>
                  <SelectItem value="reviewer">reviewer</SelectItem>
                  <SelectItem value="triager">triager</SelectItem>
                  <SelectItem value="specialist">specialist</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Specialization</Label><Input value={specialization} onChange={e => setSpecialization(e.target.value)} placeholder="e.g. security, perf" /></div>
          </div>
          <div><Label>Image (optional)</Label><Input value={image} onChange={e => setImage(e.target.value)} placeholder="your-registry/agent-harness:latest" className="font-mono text-xs" /></div>
          <div><Label>Task</Label><Textarea value={task} onChange={e => setTask(e.target.value)} placeholder="What should this template's agent do on each run?" /></div>
          <div>
            <Label>Trigger</Label>
            <Select value={trigger} onValueChange={v => setTrigger((v ?? "continuous") as Trigger)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="continuous">continuous — run 24/7</SelectItem>
                <SelectItem value="manual">manual — run on demand</SelectItem>
                <SelectItem value="schedule">schedule — cron</SelectItem>
                <SelectItem value="event">event — a ClawHub event</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {trigger === "schedule" && (
            <div><Label>Cron (5-field UTC)</Label><Input value={cron} onChange={e => setCron(e.target.value)} placeholder="0 * * * *" className="font-mono text-xs" /></div>
          )}
          {trigger === "event" && (
            <div><Label>Event</Label><Input value={event} onChange={e => setEvent(e.target.value)} placeholder="e.g. change.opened" className="font-mono text-xs" /></div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Min trust tier</Label>
              <Select value={minTrustTier} onValueChange={v => setMinTrustTier((v ?? "sandbox") as TrustTier)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="untrusted">untrusted</SelectItem>
                  <SelectItem value="sandbox">sandbox</SelectItem>
                  <SelectItem value="standard">standard</SelectItem>
                  <SelectItem value="trusted">trusted</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>LLM provider</Label>
              <Select value={llmProvider} onValueChange={v => setLlmProvider((v ?? "anthropic") as LlmProvider)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">anthropic</SelectItem>
                  <SelectItem value="openrouter">openrouter</SelectItem>
                  <SelectItem value="openai">openai</SelectItem>
                  <SelectItem value="custom">custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div><Label>LLM API key</Label><Input type="password" value={llmApiKey} onChange={e => setLlmApiKey(e.target.value)} placeholder="sealed on submit · never shown again" /></div>
          <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={earnedAutonomy} onChange={e => setEarnedAutonomy(e.target.checked)} />
            <span><span className="font-medium text-foreground">Earned autonomy</span> — {AUTONOMY_NOTE}</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => { onOpenChange(false); reset(); }}>Cancel</Button>
          <Button onClick={go} disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create template"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
