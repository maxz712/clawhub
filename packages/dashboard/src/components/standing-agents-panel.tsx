"use client";

import { useEffect, useState } from "react";
import { api, type StandingAgent } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bot, Plus, AlertTriangle } from "lucide-react";
import { StandingAgentRow } from "@/components/standing-agent-row";
import { AttachStandingAgentDialog } from "@/components/attach-standing-agent-dialog";

const STANDING_DOCS = "https://useclawhub.com/docs/standing-agents";

// Per-repo standing-agents manager (repo Settings tab + the Agents hub when a
// single repo is selected). The roster + controls are the shared StandingAgentRow
// so they match the cross-repo hub view exactly.
export function StandingAgentsPanel({ ns, repo }: { ns: string; repo: string }) {
  const [rows, setRows] = useState<StandingAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [runnerSeen, setRunnerSeen] = useState<boolean | null>(null);

  async function load() {
    try { const r = await api.listStandingAgents(ns, repo); setRows(r.standingAgents); setError(null); }
    catch (e) {
      const status = (e as { status?: number }).status;
      setError(status === 403
        ? "Standing agents are managed by an org admin. Ask an admin to attach or configure agents for this repo."
        : (e as Error).message);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [ns, repo]);
  useEffect(() => { api.runnerStatus().then(r => setRunnerSeen(r.everSeen)).catch(() => setRunnerSeen(null)); }, []);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Bring your own AI — a Claude subscription proxy, an Anthropic / OpenRouter key, or a local model — and ClawHub runs it 24/7
        in this repo to open and review Changes. The model runs in <strong>your</strong> container with <strong>your</strong> key; ClawHub
        never does inference. Every Change it opens still goes through your merge policy.{" "}
        <a className="text-primary underline" href={STANDING_DOCS} target="_blank" rel="noreferrer">Learn more</a>.
      </p>

      {runnerSeen === false && (
        <Alert className="border-yellow-500/40">
          <AlertTriangle className="h-4 w-4 text-yellow-400" />
          <AlertDescription className="text-xs text-yellow-200">
            No CI runner has connected to this instance yet. You can still attach an agent, but its runs will queue and won&apos;t execute until a runner is online. See <a className="underline" href={STANDING_DOCS} target="_blank" rel="noreferrer">the docs</a> to start one.
          </AlertDescription>
        </Alert>
      )}

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="flex justify-between items-center">
        <div className="text-sm text-muted-foreground">{rows ? `${rows.length} attached` : "Loading…"}</div>
        <Button size="sm" className="gap-2" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Attach agent</Button>
      </div>

      {rows && rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          <Bot className="h-7 w-7 mx-auto mb-2 opacity-40" />
          <div>No standing agents on this repo yet.</div>
          <Button size="sm" variant="outline" className="mt-3 gap-2" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Attach one</Button>
        </div>
      ) : rows && rows.length > 0 ? (
        <div className="rounded-lg border bg-card divide-y">
          {rows.map(s => <StandingAgentRow key={s.id} ns={ns} repo={repo} agent={s} onChanged={load} />)}
        </div>
      ) : null}

      <AttachStandingAgentDialog open={open} onOpenChange={setOpen} onAttached={load} fixedRepo={{ ns, repo }} />
    </div>
  );
}
