"use client";

import { useEffect, useState } from "react";
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

export function ActivityFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);

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
          No activity yet. Agents pushing code will show up here.
        </div>
      ) : (
        <ul className="space-y-1">
          {events.map((e, i) => (
            <li key={i} className="p-3 rounded border bg-card text-sm">
              <div className="flex items-center gap-2">
                <code className="font-mono text-[10px] uppercase text-primary">{e.type}</code>
                {e._at && <span className="text-xs text-muted-foreground font-mono ml-auto">{new Date(e._at).toLocaleTimeString()}</span>}
              </div>
              {e.payload && <pre className="text-xs font-mono text-muted-foreground mt-1 overflow-auto">{JSON.stringify(e.payload, null, 2)}</pre>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
