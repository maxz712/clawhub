"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Loader2, Activity } from "lucide-react";

interface ActivityEvent {
  id?: string;
  event_type?: string;
  type?: string;
  action?: string;
  description?: string;
  message?: string;
  actor?: string;
  agent_name?: string;
  repo_name?: string;
  risk_level?: string;
  created_at?: string;
  timestamp?: string;
}

export default function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [sseConnected, setSseConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    api
      .getActivity()
      .then((data) => {
        const items = Array.isArray(data) ? data : data.events || data.activity || [];
        setEvents(items);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    const token = getToken();
    if (token) {
      const url = `${api.getEventStreamUrl()}?token=${encodeURIComponent(token)}`;
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => setSseConnected(true);
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setEvents((prev) => [data, ...prev].slice(0, 200));
        } catch {
          // Ignore
        }
      };
      es.onerror = () => setSseConnected(false);
    }

    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const getEventLabel = (event: ActivityEvent): string => {
    return event.event_type || event.type || event.action || "event";
  };

  const getEventMessage = (event: ActivityEvent): string => {
    return event.description || event.message || getEventLabel(event);
  };

  const getEventTime = (event: ActivityEvent): string => {
    const ts = event.created_at || event.timestamp;
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const getEventDate = (event: ActivityEvent): string => {
    const ts = event.created_at || event.timestamp;
    if (!ts) return "";
    return new Date(ts).toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Group events by date
  const grouped: Record<string, ActivityEvent[]> = {};
  events.forEach((event) => {
    const date = getEventDate(event) || "Unknown";
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(event);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6 text-muted-foreground" />
            Activity Stream
          </h1>
          <p className="text-muted-foreground mt-1">
            Everything happening across your repos. Nothing here requires action.
          </p>
        </div>
        {sseConnected && (
          <Badge
            variant="outline"
            className="bg-green-500/10 text-green-400 border-green-500/30"
          >
            Live
          </Badge>
        )}
      </div>

      {events.length === 0 ? (
        <div className="text-center py-20">
          <Activity className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-30" />
          <h3 className="text-lg font-medium mb-1">No activity yet</h3>
          <p className="text-sm text-muted-foreground">
            Activity will appear here as agents push, review, and merge changes.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([date, dayEvents]) => (
            <div key={date}>
              <h3 className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wider">
                {date}
              </h3>
              <div className="border-l-2 border-border pl-4 space-y-0">
                {dayEvents.map((event, i) => (
                  <div
                    key={event.id || i}
                    className="relative flex items-start gap-3 py-2"
                  >
                    {/* Timeline dot */}
                    <div className="absolute -left-[21px] top-3 w-2 h-2 rounded-full bg-muted-foreground/40" />

                    <span className="text-xs text-muted-foreground w-12 flex-shrink-0 pt-0.5 font-mono">
                      {getEventTime(event)}
                    </span>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        {(event.actor || event.agent_name) && (
                          <span className="font-medium">{event.actor || event.agent_name} </span>
                        )}
                        {getEventMessage(event)}
                        {event.repo_name && (
                          <span className="text-muted-foreground"> in {event.repo_name}</span>
                        )}
                        {event.risk_level && (
                          <span className={`text-xs ml-1 ${
                            event.risk_level === "high" || event.risk_level === "critical"
                              ? "text-red-400"
                              : event.risk_level === "medium"
                              ? "text-yellow-400"
                              : "text-green-400"
                          }`}>
                            ({event.risk_level} risk)
                          </span>
                        )}
                      </p>
                    </div>

                    <Badge
                      variant="outline"
                      className="text-[10px] flex-shrink-0 capitalize"
                    >
                      {getEventLabel(event)}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
