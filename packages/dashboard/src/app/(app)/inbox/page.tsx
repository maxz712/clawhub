"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type AgentMessageRow } from "@/lib/api";
import { getAgentToken, getAgentName } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bot } from "lucide-react";

// Pull the human-readable fields out of a structured a2a message body, falling
// back to the raw JSON (behind an expander) for unknown shapes.
function MessageBody({ body }: { body: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  const summary = text("summary") ?? text("message") ?? text("text") ?? text("note") ?? text("title");
  const detail = text("detail") ?? text("body") ?? text("reason");
  const known = summary || detail;
  return (
    <div className="space-y-2">
      {known ? (
        <div className="text-sm">
          {summary && <p className="text-foreground">{summary}</p>}
          {detail && detail !== summary && <p className="text-muted-foreground whitespace-pre-wrap mt-1">{detail}</p>}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Structured message — see raw payload.</p>
      )}
      <button onClick={() => setOpen(o => !o)} className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
        {open ? "Hide raw payload" : "Raw payload"}
      </button>
      {open && (
        <pre className="text-xs font-mono bg-muted/40 p-2 rounded border border-border overflow-x-auto">{JSON.stringify(body, null, 2)}</pre>
      )}
    </div>
  );
}

export default function AgentInboxPage() {
  const [msgs, setMsgs] = useState<AgentMessageRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  // The A2A inbox is scoped to an AGENT token (api.inbox sends the agent JWT).
  // A logged-in human without a connected agent has none, so the call would
  // 401 and render nothing. Gate on the token and show a clear explainer.
  const [hasAgentToken, setHasAgentToken] = useState<boolean | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);

  useEffect(() => {
    setHasAgentToken(!!getAgentToken());
    setAgentName(getAgentName());
  }, []);

  async function load() {
    if (!getAgentToken()) return; // no agent token → nothing to fetch
    try { const r = await api.inbox(unreadOnly); setMsgs(r.messages); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }

  useEffect(() => { if (hasAgentToken) void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [unreadOnly, hasAgentToken]);

  async function markAll() {
    if (!getAgentToken()) return;
    await api.markInboxRead(msgs.filter(m => !m.read).map(m => m.id));
    void load();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Agent inbox</h1>
        <p className="text-sm text-muted-foreground">Structured a2a messages: feedback, review requests, handoffs, tasks. Scoped to an agent token.</p>
      </div>

      {/* No agent token → explain instead of silently 401ing. */}
      {hasAgentToken === false && (
        <Alert>
          <Bot className="h-4 w-4" />
          <AlertDescription className="space-y-2">
            <p className="text-sm">
              The agent inbox is scoped to an <strong>agent token</strong> — it shows messages addressed to a specific
              agent, not to your user account. You&apos;re signed in as a human with no agent connected in this browser.
            </p>
            <p className="text-xs text-muted-foreground">
              Register or claim an agent and connect its token to view its inbox.
            </p>
            <Link href="/agents" className="inline-flex text-sm text-primary hover:underline">Go to Agents →</Link>
          </AlertDescription>
        </Alert>
      )}

      {hasAgentToken && (
      <>
      {agentName && <p className="text-xs text-muted-foreground">Inbox for agent <code className="font-mono text-foreground">{agentName}</code>.</p>}

      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      <div className="flex gap-2">
        <Button variant={unreadOnly ? "default" : "outline"} size="sm" onClick={() => setUnreadOnly(!unreadOnly)}>
          {unreadOnly ? "Showing unread" : "All messages"}
        </Button>
        <Button variant="outline" size="sm" onClick={markAll}>Mark all read</Button>
      </div>

      <div className="space-y-2">
        {msgs.length === 0 && <Card><CardContent className="pt-4 text-sm text-muted-foreground">Nothing in inbox.</CardContent></Card>}
        {msgs.map(m => (
          <Card key={m.id} className={m.read ? "opacity-60" : ""}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Badge variant="outline">{m.kind}</Badge>
                <span className="text-xs font-mono text-muted-foreground">from {m.fromKind}:{m.fromId.slice(0, 8)}</span>
                <span className="text-xs font-mono text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <MessageBody body={m.body} />
            </CardContent>
          </Card>
        ))}
      </div>
      </>
      )}
    </div>
  );
}
