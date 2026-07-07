"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { displayBranch } from "@/lib/branch";
import { formatRelativeTime, absoluteTime } from "@/lib/time";
import { Card, CardContent } from "@/components/ui/card";

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

/** Resolve an actor to a readable name: prefer a name carried in the event
 *  payload, else the caller's known-agents map, else a short id. Humans and
 *  agents both push, so a human actor reads as their own name (not a generic
 *  "A human") whenever the payload carries it. */
function actorLabel(e: FeedEvent, names: Map<string, string>): string {
  if (e.actorKind === "system") return "ClawHub";
  const fromPayload = typeof e.payload?.actorName === "string" ? e.payload.actorName
    : typeof e.payload?.userName === "string" ? e.payload.userName
      : typeof e.payload?.agentName === "string" ? e.payload.agentName
        : undefined;
  if (fromPayload) return e.actorKind === "human" ? `@${fromPayload.replace(/^@/, "")}` : fromPayload;
  if (e.actorKind === "human") return "A human";
  if (e.actorId && names.has(e.actorId)) return names.get(e.actorId)!;
  return short(e.actorId);
}

/** Maps a streamed event to a readable one-line sentence. */
function summariseEvent(e: FeedEvent, names: Map<string, string>): string {
  const actor = actorLabel(e, names);
  const verb = TYPE_VERB[e.type] ?? e.type.replace(/\./g, " ");
  const branch = typeof e.payload?.branch === "string" ? e.payload.branch : undefined;
  const where = e.issueNumber ? ` #${e.issueNumber}` : branch ? ` on ${displayBranch(branch)}` : "";
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
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={`h-2 w-2 rounded-full ${connected ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
        {connected ? "Live" : "Disconnected"}
      </div>
      {events.length === 0 ? (
        <Card className="py-0">
          <CardContent className="p-6 text-center text-muted-foreground text-sm">
            Live events appear here as they happen.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1">
          {events.map((e, i) => (
            <EventRow key={i} event={e} agentNames={agentNames} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ event, agentNames }: { event: FeedEvent; agentNames: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const hasPayload = event.payload && Object.keys(event.payload).length > 0;
  const href = eventHref(event);
  return (
    <Card className="py-0">
      <CardContent className="p-3 text-sm">
        <div className="flex items-center gap-2">
          {href ? <Link href={href} className="min-w-0 flex-1 break-words text-foreground hover:underline">{summariseEvent(event, agentNames)}</Link> : <span className="min-w-0 flex-1 break-words text-foreground">{summariseEvent(event, agentNames)}</span>}
          {event._at && <span className="shrink-0 ml-auto whitespace-nowrap text-xs text-muted-foreground" title={absoluteTime(event._at)}>{formatRelativeTime(event._at)}</span>}
        </div>
        {hasPayload && (
          <button onClick={() => setOpen(o => !o)} className="mt-1 inline-flex min-h-[44px] items-center px-1 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground">
            {open ? "Hide details" : "Details"}
          </button>
        )}
        {open && hasPayload && (
          <pre className="text-xs font-mono text-muted-foreground mt-1 overflow-auto">{JSON.stringify(event.payload, null, 2)}</pre>
        )}
      </CardContent>
    </Card>
  );
}
