"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { Activity, AlertCircle } from "lucide-react";

interface ActivityEvent {
  id?: string;
  event_type?: string;
  type?: string;
  action?: string;
  description?: string;
  message?: string;
  actor?: string;
  repo_name?: string;
  created_at?: string;
  timestamp?: string;
}

export function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [sseConnected, setSseConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Load initial activity
    api
      .getActivity()
      .then((data) => {
        const items = Array.isArray(data) ? data : data.events || data.activity || [];
        setEvents(items.slice(0, 20));
      })
      .catch(() => {
        // Activity endpoint might not return data yet
      })
      .finally(() => setLoading(false));

    // Connect to SSE
    const token = getToken();
    if (token) {
      const url = `${api.getEventStreamUrl()}?token=${encodeURIComponent(token)}`;
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => setSseConnected(true);
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setEvents((prev) => [data, ...prev].slice(0, 50));
        } catch {
          // Ignore unparseable events
        }
      };
      es.onerror = () => {
        setSseConnected(false);
      };
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
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Activity Feed
          </CardTitle>
          {sseConnected && (
            <Badge
              variant="outline"
              className="bg-green-500/10 text-green-400 border-green-500/30 text-[10px]"
            >
              Live
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse">
                <div className="h-3 bg-muted rounded w-3/4 mb-1"></div>
                <div className="h-2 bg-muted rounded w-1/2"></div>
              </div>
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No recent activity</p>
          </div>
        ) : (
          <div className="space-y-3 max-h-[400px] overflow-y-auto">
            {events.map((event, i) => (
              <div
                key={event.id || i}
                className="flex items-start gap-3 text-sm border-b border-border/50 pb-3 last:border-0"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-foreground leading-snug truncate">
                    {getEventMessage(event)}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {event.actor && (
                      <span className="text-xs text-muted-foreground">
                        {event.actor}
                      </span>
                    )}
                    {event.repo_name && (
                      <span className="text-xs text-muted-foreground">
                        in {event.repo_name}
                      </span>
                    )}
                    {getEventTime(event) && (
                      <span className="text-xs text-muted-foreground">
                        {getEventTime(event)}
                      </span>
                    )}
                  </div>
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
        )}
      </CardContent>
    </Card>
  );
}
