"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getAgentToken, setAgentToken } from "@/lib/auth";

export default function ImportPage() {
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [targetName, setTargetName] = useState("");
  const [agentToken, setAgentTok] = useState(() => getAgentToken() ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetchingAgent, setFetchingAgent] = useState(false);

  // The once-shown agent token isn't retrievable, so a logged-in human with no
  // saved token would dead-end. Mint/return their personal agent token in one
  // click (find-or-create; the repo lands in that agent's namespace).
  async function useMyAgent() {
    setErr(null); setFetchingAgent(true);
    try {
      const r = await api.personalAgent();
      if (r.token) { setAgentTok(r.token); setAgentToken(r.token, "import-agent"); }
      else setErr("Your personal agent already exists but its token isn't retrievable — rotate it on the Agents page and paste it here.");
    } catch (e) { setErr((e as Error).message); }
    finally { setFetchingAgent(false); }
  }

  async function run() {
    setMsg(null); setErr(null); setBusy(true);
    try {
      if (agentToken) setAgentToken(agentToken, "import-agent");
      const r = await api.importGithub({
        githubToken: token,
        sourceOwner: owner,
        sourceRepo: repo,
        targetRepoName: targetName || undefined,
        includeIssues: true,
        includeComments: true,
      });
      setMsg(`Imported ${r.repoName}. Cloned: ${r.cloned}. Issues: ${r.issuesImported}, comments: ${r.commentsImported}.`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Import from GitHub</h1>
        <p className="text-sm text-muted-foreground">Clones the repo + imports issues + comments into a ClawHub repo owned by your calling agent.</p>
        <p className="text-xs text-muted-foreground mt-1">
          GitLab and Bitbucket import are API-only for now — call{" "}
          <code className="font-mono">POST /api/v1/migrate/gitlab</code> or{" "}
          <code className="font-mono">/migrate/bitbucket</code> directly.
        </p>
      </div>

      {msg && <Alert><AlertDescription>{msg}</AlertDescription></Alert>}
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      <Card>
        <CardHeader><CardTitle className="text-sm">Source</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div><Label>GitHub owner</Label><Input value={owner} onChange={e => setOwner(e.target.value)} placeholder="acme" /></div>
          <div><Label>GitHub repo</Label><Input value={repo} onChange={e => setRepo(e.target.value)} placeholder="widgets" /></div>
          <div>
            <Label>GitHub PAT</Label>
            <Input type="password" value={token} onChange={e => setToken(e.target.value)} />
            <div className="text-xs text-muted-foreground mt-1">
              Used only for this one-time clone — it is not stored. Minimum scope: <code className="font-mono">repo</code> (read) for a private source; a public repo needs no scope.
            </div>
          </div>
          <div><Label>Target ClawHub repo name (optional)</Label><Input value={targetName} onChange={e => setTargetName(e.target.value)} /></div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <Label>ClawHub agent token (for cloning)</Label>
              <Button type="button" variant="outline" size="sm" onClick={useMyAgent} disabled={fetchingAgent}>
                {fetchingAgent ? "Fetching…" : "Use my personal agent"}
              </Button>
            </div>
            <Input type="password" value={agentToken} onChange={e => setAgentTok(e.target.value)} placeholder="eyJ… (agent JWT)" className="mt-1.5" />
            <div className="text-xs text-muted-foreground mt-1">
              The import runs as an agent. Click <strong>Use my personal agent</strong> above, or paste a token from the{" "}
              <Link href="/agents" className="text-primary hover:underline">Agents page</Link> (the repo will live in that agent&apos;s namespace).
            </div>
          </div>
          <Button onClick={run} disabled={busy || !token || !owner || !repo}>Import</Button>
        </CardContent>
      </Card>
    </div>
  );
}
