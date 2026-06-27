"use client";

import { useEffect, useState } from "react";
import { api, type CiPipeline, type CiRun, type TriggerKind } from "@/lib/api";
import { nextCronFire, relativeTime, parseCron } from "@/lib/cron";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TriggerBadge } from "@/components/trigger-badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { Clock, Zap, Terminal, CheckCircle2 } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

// Only event types that can actually drive an event-pipeline. Each must be (a)
// published by an emitter and (b) NOT a ci.* event — the fan-out guard refuses
// to trigger pipelines on ci.* to avoid loops (services/event-pipeline-trigger.ts).
// (change.approved was a dead trigger — never published — so it's gone.)
const EVENT_TYPES = [
  "change.opened",
  "change.updated",
  "change.merged",
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
  const [saved, setSaved] = useState(false);

  // Auto-dismiss the transient "Saved" chip ~2s after a successful save.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(t);
  }, [saved]);

  function reset() {
    setEditing(null); setName(""); setKind("push");
    setCron("0 3 * * *"); setEvent("change.merged"); setBody(STARTER_STEPS); setError(null); setSaved(false);
  }

  function loadInto(p: CiPipeline) {
    setEditing(p);
    setName(p.name);
    setKind(p.triggerKind);
    setCron(p.triggerConfig.cron ?? "0 3 * * *");
    setEvent(p.triggerConfig.event ?? "change.merged");
    setBody(stripTriggerLines(p.yaml));
    setError(null);
    setSaved(false);
  }

  // Live validation + preview for the schedule cron.
  let cronError: string | null = null;
  let nextRun: Date | null = null;
  if (kind === "schedule") {
    try { parseCron(cron); nextRun = nextCronFire(cron); }
    catch (e) { cronError = (e as Error).message; }
  }

  async function save() {
    setError(null); setSaved(false);
    if (kind === "schedule" && cronError) { setError(`Invalid cron: ${cronError}`); return; }
    if (kind === "event" && !event.trim()) { setError("Event type required"); return; }
    setPending(true);
    try {
      const config = kind === "schedule" ? { cron: cron.trim() } : kind === "event" ? { event: event.trim() } : {};
      // Body carries name + steps; the trigger header is synthesized by upsertPipeline.
      const yaml = `name: ${name || "default"}\n${stripTriggerLines(body)}`;
      const r = await api.upsertPipeline(ns, repo, name || "default", yaml, true, { kind, config });
      await onChange();
      // Keep the form populated after save — flip into "editing" the just-saved
      // pipeline so it reflects the persisted state instead of blanking out.
      if (r.pipeline) setEditing(r.pipeline);
      setSaved(true);
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  return (
    <div className="space-y-6">
      {/* Runner setup — CI does nothing until a runner connects, so lead with it. */}
      <RunnerSetup />

      {/* Editor card */}
      <Card>
        <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{editing ? `Edit "${editing.name}"` : "New pipeline"}</h3>
          {editing && <Button variant="ghost" size="sm" onClick={reset}>New pipeline</Button>}
        </div>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={pending || !!cronError}>
            {pending ? "Saving…" : editing ? "Update pipeline" : "Create pipeline"}
          </Button>
          {saved && <span className="flex items-center gap-1 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" /> Saved</span>}
        </div>
        </CardContent>
      </Card>

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

/**
 * Setup checklist for the CI tab. CI does nothing until a runner connects to
 * this instance — without one, push pipelines stay pending forever and (if
 * `ciRequired`) block merges. Lead the tab with the prerequisites + the exact
 * start command so the user can stand a runner up before authoring pipelines.
 */
function RunnerSetup() {
  return (
    <Alert>
      <Terminal className="h-4 w-4" />
      <AlertDescription className="space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Before CI runs: connect a runner</p>
          <p className="text-sm text-muted-foreground">
            CI steps execute on a <strong>runner you host</strong> — nothing runs until one connects to this
            instance. Push pipelines stay pending until then, and a required pipeline (<code className="font-mono">ciRequired</code>)
            will block merges.
          </p>
        </div>

        <ol className="space-y-1.5 text-sm">
          <li className="flex gap-2">
            <span className="font-mono text-xs text-muted-foreground shrink-0">1.</span>
            <span><strong>Install Docker</strong> on the runner host — the runner executes each step in a Docker container, so the Docker daemon must be running.</span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-xs text-muted-foreground shrink-0">2.</span>
            <span>Get an <strong>agent JWT</strong> for the runner. For a team, dedicate a runner agent (e.g. <code className="font-mono">ci-runner</code>) rather than reusing a developer&apos;s token.</span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-xs text-muted-foreground shrink-0">3.</span>
            <span>Start the runner with that token:</span>
          </li>
        </ol>

        <pre className="font-mono text-[11px] whitespace-pre-wrap rounded bg-muted/50 border border-border px-2 py-1.5 overflow-x-auto">
          {`CLAWHUB_URL=${API_BASE} CLAWHUB_TOKEN=<agent JWT> npm -w @clawhub/runner run dev`}
        </pre>

        <p className="text-xs text-muted-foreground">
          Leave a runner up to keep CI green. If a pipeline is required to merge and no runner is connected,
          relax <code className="font-mono">ciRequired</code> in Settings.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function PipelineRow({ p, onEdit }: { p: CiPipeline; onEdit: () => void }) {
  let next: Date | null = null;
  if (p.triggerKind === "schedule" && p.triggerConfig.cron) next = nextCronFire(p.triggerConfig.cron);
  return (
    <Card>
      <CardContent className="p-3">
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
      </CardContent>
    </Card>
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
            <Card className="py-0">
              <CardContent className="divide-y p-0">
              {runs.map(run => {
                // origin records what enqueued the run; fall back to the pipeline's
                // trigger kind for legacy push/merge rows that left origin null.
                const pipe = run.pipelineId ? byId.get(run.pipelineId) : undefined;
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
              </CardContent>
            </Card>
          )}
    </div>
  );
}
