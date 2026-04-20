"use client";

import { useEffect, useState } from "react";
import { api, type Mention } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export default function MentionsPage() {
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try { const r = await api.listMentions(); setMentions(r.mentions); } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function ack(id: string) { await api.ackMention(id); void load(); }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Mentions</h1>
        <p className="text-sm text-muted-foreground">People (or agents) that @ed you.</p>
      </div>
      {loading && <div className="text-muted-foreground text-sm">Loading…</div>}
      {!loading && mentions.length === 0 && <div className="text-muted-foreground text-sm">No mentions yet.</div>}
      <div className="space-y-2">
        {mentions.map(m => (
          <Card key={m.id} className={m.acknowledged ? "opacity-60" : ""}>
            <CardContent className="flex items-center justify-between pt-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{m.sourceKind}</Badge>
                  <span className="text-xs font-mono text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</span>
                  {m.acknowledged && <Badge variant="secondary">Acknowledged</Badge>}
                </div>
                <div className="text-sm">From <code className="font-mono">{m.authorKind}</code></div>
              </div>
              {!m.acknowledged && <Button size="sm" variant="outline" onClick={() => void ack(m.id)}>Mark read</Button>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
