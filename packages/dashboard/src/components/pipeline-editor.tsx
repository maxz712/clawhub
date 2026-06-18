"use client";

import { useEffect, useState } from "react";
import { api, type CiPipeline, type CiRun, type TriggerKind } from "@/lib/api";
import { nextCronFire, relativeTime, parseCron } from "@/lib/cron";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TriggerBadge } from "@/components/trigger-badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { Clock, Zap } from "lucide-react";

const EVENT_TYPES = [
  "change.opened",
  "change.updated",
  "change.merged",
  "change.approved",
  "issue.opened",
  "issue.closed",
  "release.created",
];

const STARTER_STEPS = "steps:\n  - run: npm test\n";

/** Strip the `on:`/`cron:`/`event:` header lines — the trigger is owned by the picker. */
function stripTriggerLines(yaml: string): string {
  return yaml
    .split(/\r?\n/)
    .filter(l => !/^(on|cron|event)\s*:/.test(l.trim()))
    .join("\n")
    .replace(/^\n+/, "");
}

export function PipelineEditor({ ns, repo, pipelines, onChange }: {
  ns: string; repo: string; pipelines: CiPipeline[]; onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<CiPipeline | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TriggerKind>("push");
  const [cron, setCron] = useState("0 3 * * *");
  const [event, setEvent] = useState("change.merged");
  const [body, setBody] = useState(STARTER_STEPS);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setEditing(null); setName(""); setKind("push");
    setCron("0 3 * * *"); setEvent("change.merged"); setBody(STARTER_STEPS); setError(null);
  }

  function loadInto(p: CiPipeline) {
    setEditing(p);
    setName(p.name);
    setKind(p.triggerKind);
    setCron(p.triggerConfig.cron ?? "0 3 * * *");
    setEvent(p.triggerConfig.event ?? "change.merged");
    setBody(stripTriggerLines(p.yaml));
    setError(null);
  }

  // Live validation + preview for the schedule cron.
  let cronError: string | null = null;
  let nextRun: Date | null = null;
  if (kind === "schedule") {
    try { parseCron(cron); nextRun = nextCronFire(cron); }
    catch (e) { cronError = (e as Error).message; }
  }

  async function save() {
    setError(null);
    if (kind === "schedule" && cronError) { setError(`Invalid cron: ${cronError}`); return; }
    if (kind === "event" && !event.trim()) { setError("Event type required"); return; }
    setPending(true);
    try {
      const config = kind === "schedule" ? { cron: cron.trim() } : kind === "event" ? { event: event.trim() } : {};
      // Body carries name + steps; the trigger header is synthesized by upsertPipeline.
      const yaml = `name: ${name || "default"}\n${stripTriggerLines(body)}`;
      await api.upsertPipeline(ns, repo, name || "default", yaml, true, { kind, config });
      await onChange();
      reset();
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  return (
    <div className="space-y-6">
      {/* Editor card */}
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{editing ? `Edit "${editing.name}"` : "New pipeline"}</h3>
          {editing && <Button variant="ghost" size="sm" onClick={reset}>New pipeline</Button>}
        </div>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              placeholder="tests"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={!!editing}
              title={editing ? "Pipeline names are immutable — delete and recreate to rename" : undefined}
            />
            {editing && <p className="text-xs text-muted-foreground">Name can&apos;t be changed after creation — delete and recreate to rename.</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Trigger</Label>
            <Select value={kind} onValueChange={v => setKind(v as TriggerKind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="push">On push (every Change)</SelectItem>
                <SelectItem value="merge">On merge (default branch)</SelectItem>
                <SelectItem value="schedule">Schedule (cron)</SelectItem>
                <SelectItem value="event">On event</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Trigger-specific reveal */}
        {kind === "schedule" && (
          <div className="space-y-1.5">
            <Label>Cron (5-field, UTC)</Label>
            <Input className="font-mono text-xs" placeholder="*/5 * * * *" value={cron} onChange={e => setCron(e.target.value)} />
            {cronError
              ? <p className="text-xs text-destructive">{cronError}</p>
              : nextRun
                ? <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Clock className="h-3 w-3" /> Next run {relativeTime(nextRun)} ·
                    <span className="font-mono">{nextRun.toISOString().replace("T", " ").slice(0, 16)} UTC</span>
                  </p>
                : <p className="text-xs text-muted-foreground">No upcoming run within 4 years.</p>}
          </div>
        )}
        {kind === "event" && (
          <div className="space-y-1.5">
            <Label>Event type</Label>
            <Select value={event} onValueChange={v => setEvent(v ?? "")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {EVENT_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Zap className="h-3 w-3" /> Fires at default-branch HEAD when this event occurs.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Steps (YAML)</Label>
          <Textarea className="font-mono text-xs" rows={8} value={body} onChange={e => setBody(e.target.value)} />
        </div>

        <Button onClick={save} disabled={pending || !!cronError}>
          {pending ? "Saving…" : editing ? "Update pipeline" : "Create pipeline"}
        </Button>
      </div>

      {/* Pipeline list */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Pipelines</h3>
        {pipelines.length === 0
          ? <div className="text-sm text-muted-foreground">No pipelines configured.</div>
          : pipelines.map(p => <PipelineRow key={p.id} p={p} onEdit={() => loadInto(p)} />)}
      </div>

      {/* Runs */}
      <RunsList ns={ns} repo={repo} pipelines={pipelines} />
    </div>
  );
}

function PipelineRow({ p, onEdit }: { p: CiPipeline; onEdit: () => void }) {
  let next: Date | null = null;
  if (p.triggerKind === "schedule" && p.triggerConfig.cron) next = nextCronFire(p.triggerConfig.cron);
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <code className="font-mono text-sm text-primary truncate">{p.name}</code>
          <TriggerBadge kind={p.triggerKind} />
          {!p.enabled && <span className="text-[10px] uppercase tracking-wider text-muted-foreground">disabled</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
      </div>

      {p.triggerKind === "schedule" && p.triggerConfig.cron && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          <code className="font-mono">{p.triggerConfig.cron}</code>
          <span>·</span>
          {next
            ? <span>next run {relativeTime(next)} <span className="font-mono">({next.toISOString().slice(0, 16).replace("T", " ")} UTC)</span></span>
            : <span>no upcoming run</span>}
          {p.lastScheduledRunAt && <span>· last fired {relativeTime(new Date(p.lastScheduledRunAt))}</span>}
        </div>
      )}
      {p.triggerKind === "event" && p.triggerConfig.event && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Zap className="h-3 w-3" /> on <code className="font-mono">{p.triggerConfig.event}</code>
        </div>
      )}
    </div>
  );
}

function RunsList({ ns, repo, pipelines }: { ns: string; repo: string; pipelines: CiPipeline[] }) {
  const [runs, setRuns] = useState<CiRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(pipelines.map(p => [p.id, p]));

  useEffect(() => {
    api.listCiRuns(ns, repo)
      .then(r => setRuns(r.runs))
      .catch(e => setError((e as Error).message));
  }, [ns, repo]);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-muted-foreground">Recent runs</h3>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {runs === null ? <div className="text-sm text-muted-foreground">Loading…</div>
        : runs.length === 0 ? <div className="text-sm text-muted-foreground">No runs yet.</div>
          : (
            <div className="divide-y rounded-lg border bg-card">
              {runs.map(run => {
                // origin records what enqueued the run; fall back to the pipeline's
                // trigger kind for legacy push/merge rows that left origin null.
                const pipe = byId.get(run.pipelineId);
                const origin = run.origin ?? pipe?.triggerKind ?? "push";
                return (
                  <div key={run.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <CiStatusPill status={run.status} />
                      <code className="font-mono text-xs text-foreground truncate">{pipe?.name ?? "—"}</code>
                      <TriggerBadge kind={origin} />
                      {run.triggerEvent && <code className="font-mono text-[10px] text-muted-foreground truncate">{run.triggerEvent}</code>}
                      {run.commit && <code className="font-mono text-[10px] text-muted-foreground">{run.commit.slice(0, 7)}</code>}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {relativeTime(new Date(run.createdAt))}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
    </div>
  );
}
