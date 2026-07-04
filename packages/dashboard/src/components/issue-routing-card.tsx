"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Route, Trash2 } from "lucide-react";

interface Rule { id: string; label: string; agentId: string; agentName: string | null; priority: number; enabled: boolean }
interface AgentOpt { agentId: string; name: string }

/**
 * Issue routing (N5): label → agent auto-assignment rules. A matching, still-
 * unassigned issue is assigned to the highest-priority rule's agent on create or
 * on a new label. Use "*" as the label for a catch-all. Rules can only target an
 * agent that is a collaborator on the repo.
 */
export function IssueRoutingCard({ ns, repo }: { ns: string; repo: string }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [agents, setAgents] = useState<AgentOpt[]>([]);
  const [label, setLabel] = useState("");
  const [agentId, setAgentId] = useState("");
  const [priority, setPriority] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, collab] = await Promise.all([api.listIssueRouting(ns, repo), api.listCollaborators(ns, repo)]);
      setRules(r.rules);
      const opts = collab.collaborators.filter(c => c.kind === "agent" && c.agentId).map(c => ({ agentId: c.agentId!, name: c.agentName ?? "agent" }));
      setAgents(opts);
      if (!agentId && opts[0]) setAgentId(opts[0].agentId);
    } catch (e) { setError((e as Error).message); }
    finally { setLoaded(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ns, repo]);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    setError(null);
    try {
      await api.setIssueRouting(ns, repo, { label: label.trim(), agentId, priority: Number(priority) || 0 });
      setLabel("");
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function remove(l: string) {
    setError(null);
    try { await api.deleteIssueRouting(ns, repo, l); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  if (!loaded) return null;

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-1.5"><Route className="h-4 w-4" /> Issue routing</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {error && <Alert variant="destructive"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}
        <p className="text-xs text-muted-foreground">
          Auto-assign a new, unassigned issue to an agent by label. Highest priority wins; a specific
          label beats <code className="font-mono">*</code> at equal priority. Only repo collaborators can be targets.
        </p>
        {rules.length > 0 ? (
          <ul className="space-y-1">
            {rules.map(r => (
              <li key={r.id} className="flex items-center justify-between rounded border border-border px-2 py-1.5 text-sm">
                <span>
                  <code className="font-mono text-xs bg-muted px-1 rounded">{r.label}</code>
                  <span className="text-muted-foreground"> → </span>
                  <span>{r.agentName ?? r.agentId.slice(0, 8)}</span>
                  <span className="text-muted-foreground text-xs"> · p{r.priority}{r.enabled ? "" : " · disabled"}</span>
                </span>
                <Button size="sm" variant="ghost" className="h-6 text-destructive" onClick={() => void remove(r.label)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-muted-foreground">No routing rules yet.</p>}
        {agents.length === 0
          ? <p className="text-xs text-amber-500">Add an agent collaborator first to create routing rules.</p>
          : (
            <div className="flex items-end gap-2 flex-wrap border-t border-border pt-3">
              <div className="w-28"><Label className="text-xs">Label</Label><Input value={label} onChange={e => setLabel(e.target.value)} placeholder="bug or *" /></div>
              <div>
                <Label className="text-xs">Agent</Label>
                <select value={agentId} onChange={e => setAgentId(e.target.value)} className="block h-9 rounded-md border border-border bg-background px-2 text-sm">
                  {agents.map(a => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
                </select>
              </div>
              <div className="w-20"><Label className="text-xs">Priority</Label><Input type="number" value={priority} onChange={e => setPriority(e.target.value)} /></div>
              <Button size="sm" onClick={() => void add()} disabled={!label.trim() || !agentId}>Add rule</Button>
            </div>
          )}
      </CardContent>
    </Card>
  );
}
