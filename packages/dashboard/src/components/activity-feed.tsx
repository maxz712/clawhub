"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

interface FeedEvent {
  type: string;
  repoId?: string;
  changeId?: string;
  issueNumber?: number;
  actorKind?: "agent" | "human" | "system";
  actorId?: string;
  payload?: Record<string, unknown>;
  _at?: number;
}

/**
 * Build a dashboard URL to the change/issue an event references, so the stream
 * isn't a dead-end. Repo routes are keyed by `ns/repo` (not the UUID `repoId`),
 * so we can only link when the event payload carries the namespace + repo name.
 */
function eventHref(e: FeedEvent): string | null {
  const ns = typeof e.payload?.repoNs === "string" ? e.payload.repoNs : undefined;
  const name = typeof e.payload?.repoName === "string" ? e.payload.repoName : undefined;
  if (!ns || !name) return null;
  if (e.changeId) return `/repos/${ns}/${name}/changes/${e.changeId}`;
  if (typeof e.issueNumber === "number") return `/repos/${ns}/${name}/issues/${e.issueNumber}`;
  return null;
}

const TYPE_VERB: Record<string, string> = {
  "change.opened": "opened a change",
  "change.updated": "updated a change",
  "change.merged": "merged a change",
  "change.approved": "approved a change",
  "review.submitted": "submitted a review",
  "issue.opened": "opened an issue",
  "issue.closed": "closed an issue",
  "issue.commented": "commented on an issue",
  "ci.completed": "ran CI",
  "release.created": "cut a release",
};

function short(id: string | undefined): string {
  if (!id) return "someone";
  return id.length > 10 ? id.slice(0, 8) : id;
}

/** Resolve an agent actor to a readable name: prefer a name carried in the event
 *  payload, else the caller's known-agents map, else a short id. */
function actorLabel(e: FeedEvent, names: Map<string, string>): string {
  if (e.actorKind === "human") return "A human";
  if (e.actorKind === "system") return "ClawHub";
  const fromPayload = typeof e.payload?.agentName === "string" ? e.payload.agentName : typeof e.payload?.actorName === "string" ? e.payload.actorName : undefined;
  if (fromPayload) return fromPayload;
  if (e.actorId && names.has(e.actorId)) return names.get(e.actorId)!;
  return short(e.actorId);
}

/** Maps a streamed event to a readable one-line sentence. */
function summariseEvent(e: FeedEvent, names: Map<string, string>): string {
  const actor = actorLabel(e, names);
  const verb = TYPE_VERB[e.type] ?? e.type.replace(/\./g, " ");
  const branch = typeof e.payload?.branch === "string" ? e.payload.branch : undefined;
  const where = e.issueNumber ? ` #${e.issueNumber}` : branch ? ` on ${branch}` : "";
  return `${actor} ${verb}${where}`;
}

export function ActivityFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [agentNames, setAgentNames] = useState<Map<string, string>>(new Map());

  // The caller's own agents cover most of what shows on their home feed; resolve
  // their ids to names so the stream reads "deploy-bot opened a change" not a UUID.
  useEffect(() => {
    api.listAgents().then(r => setAgentNames(new Map(r.agents.map(a => [a.id, a.name])))).catch(() => {});
  }, []);

  useEffect(() => {
    const url = api.eventStreamUrl();
    const es = new EventSource(url);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    const handle = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as FeedEvent;
        if (parsed.type === "ping") return;
        setEvents(prev => [{ ...parsed, _at: Date.now() }, ...prev].slice(0, 100));
      } catch { /* ignore */ }
    };
    es.addEventListener("message", handle);
    ["change.opened", "change.updated", "change.merged", "review.submitted", "issue.opened", "issue.closed", "ci.completed", "release.created"].forEach(t => es.addEventListener(t, handle));

    return () => es.close();
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
        <span className={`h-2 w-2 rounded-full ${connected ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
        {connected ? "live" : "disconnected"}
      </div>
      {events.length === 0 ? (
        <div className="p-6 text-center text-muted-foreground text-sm rounded border bg-card">
          Live events appear here as they happen.
        </div>
      ) : (
        <ul className="space-y-1">
          {events.map((e, i) => (
            <EventRow key={i} event={e} agentNames={agentNames} />
          ))}
        </ul>
      )}
    </div>
  );
}

function EventRow({ event, agentNames }: { event: FeedEvent; agentNames: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const hasPayload = event.payload && Object.keys(event.payload).length > 0;
  const href = eventHref(event);
  const summary = <span className="text-foreground">{summariseEvent(event, agentNames)}</span>;
  return (
    <li className="p-3 rounded border bg-card text-sm">
      <div className="flex items-center gap-2">
        {href ? <Link href={href} className="text-foreground hover:underline">{summariseEvent(event, agentNames)}</Link> : summary}
        {event._at && <span className="text-xs text-muted-foreground font-mono ml-auto">{new Date(event._at).toLocaleTimeString()}</span>}
      </div>
      {hasPayload && (
        <button onClick={() => setOpen(o => !o)} className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
          {open ? "Hide details" : "Details"}
        </button>
      )}
      {open && hasPayload && (
        <pre className="text-xs font-mono text-muted-foreground mt-1 overflow-auto">{JSON.stringify(event.payload, null, 2)}</pre>
      )}
    </li>
  );
}
