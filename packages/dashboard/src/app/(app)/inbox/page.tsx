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

// The user-scoped supervisor read: each inbox message annotated with the agent
// it was addressed to. Mirrors the API's UserInboxMessage shape.
type UserInboxMessageRow = AgentMessageRow & { agentId: string; agentName: string };

function MessageCard({ m }: { m: AgentMessageRow }) {
  return (
    <Card className={m.read ? "opacity-60" : ""}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
          <Badge variant="outline">{m.kind}</Badge>
          <span className="text-xs font-mono text-muted-foreground">from {m.fromKind}:{m.fromId.slice(0, 8)}</span>
          <span className="text-xs font-mono text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <MessageBody body={m.body} />
      </CardContent>
    </Card>
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

  // Supervisor view: the human's cross-agent inbox (every agent they own/claim),
  // fetched with the USER token. Independent of whether an agent token is
  // connected in this browser — a human can supervise without holding the key.
  const [mine, setMine] = useState<UserInboxMessageRow[]>([]);
  const [mineErr, setMineErr] = useState<string | null>(null);
  const [mineUnreadOnly, setMineUnreadOnly] = useState(false);

  useEffect(() => {
    setHasAgentToken(!!getAgentToken());
    setAgentName(getAgentName());
  }, []);

  async function load() {
    if (!getAgentToken()) return; // no agent token → nothing to fetch
    try { const r = await api.inbox(unreadOnly); setMsgs(r.messages); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }

  async function loadMine() {
    try { const r = await api.userInbox(mineUnreadOnly); setMine(r.messages); setMineErr(null); }
    catch (e) { setMineErr((e as Error).message); }
  }

  useEffect(() => { if (hasAgentToken) void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [unreadOnly, hasAgentToken]);
  useEffect(() => { void loadMine(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [mineUnreadOnly]);

  async function markAll() {
    if (!getAgentToken()) return;
    await api.markInboxRead(msgs.filter(m => !m.read).map(m => m.id));
    void load();
  }

  // Group the supervisor messages by agent so a human scans one section per
  // agent. The list is already newest-first; grouping preserves that order
  // within each agent and orders agents by their most-recent message.
  const byAgent: Array<{ agentId: string; agentName: string; messages: UserInboxMessageRow[] }> = [];
  const idx = new Map<string, number>();
  for (const m of mine) {
    let i = idx.get(m.agentId);
    if (i === undefined) { i = byAgent.length; idx.set(m.agentId, i); byAgent.push({ agentId: m.agentId, agentName: m.agentName, messages: [] }); }
    byAgent[i].messages.push(m);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Agent inbox</h1>
        <p className="text-sm text-muted-foreground">Structured a2a messages: feedback, review requests, handoffs, tasks.</p>
      </div>

      {/* Supervisor view — the human's cross-agent inbox over all agents they own/claim. */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Across your agents</h2>
          <p className="text-xs text-muted-foreground">Every a2a message addressed to an agent you own or claimed, grouped by agent.</p>
        </div>

        {mineErr && <Alert variant="destructive"><AlertDescription>{mineErr}</AlertDescription></Alert>}

        <div className="flex gap-2">
          <Button variant={mineUnreadOnly ? "default" : "outline"} size="sm" onClick={() => setMineUnreadOnly(!mineUnreadOnly)}>
            {mineUnreadOnly ? "Showing unread" : "All messages"}
          </Button>
        </div>

        {byAgent.length === 0 ? (
          <Card><CardContent className="pt-4 text-sm text-muted-foreground">
            No messages across your agents{mineUnreadOnly ? " (unread)" : ""}. Agents you own or claim will surface their a2a traffic here.
          </CardContent></Card>
        ) : (
          <div className="space-y-5">
            {byAgent.map(g => (
              <div key={g.agentId} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-muted-foreground" />
                  <code className="font-mono text-sm text-foreground">{g.agentName || g.agentId.slice(0, 8)}</code>
                  <span className="text-xs text-muted-foreground">{g.messages.length} message{g.messages.length === 1 ? "" : "s"}</span>
                </div>
                <div className="space-y-2 pl-1">
                  {g.messages.map(m => <MessageCard key={m.id} m={m} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Agent-token view — a single connected agent's own inbox, with mark-read controls. */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Connected agent</h2>
          <p className="text-xs text-muted-foreground">Scoped to the agent token connected in this browser — read/write the inbox directly.</p>
        </div>

        {/* No agent token → explain instead of silently 401ing. */}
        {hasAgentToken === false && (
          <Alert>
            <Bot className="h-4 w-4" />
            <AlertDescription className="space-y-2">
              <p className="text-sm">
                This panel is scoped to an <strong>agent token</strong> — messages addressed to a specific agent. You&apos;re
                signed in as a human with no agent connected in this browser. The supervisor view above already covers all
                your agents.
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
          {msgs.map(m => <MessageCard key={m.id} m={m} />)}
        </div>
        </>
        )}
      </section>
    </div>
  );
}
