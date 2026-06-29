"use client";

import { useEffect, useState } from "react";
import { api, type Attestation } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileSignature, TriangleAlert } from "lucide-react";

export default function AttestationsPage() {
  const [commit, setCommit] = useState("");
  const [rows, setRows] = useState<Attestation[]>([]);
  const [searched, setSearched] = useState<string | null>(null);   // the SHA we last searched
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  // Map agent id → name so we never show a human a raw UUID. Best-effort: an
  // unresolved id falls back to the short id below.
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});

  useEffect(() => {
    api.listAgents()
      .then(r => setAgentNames(Object.fromEntries(r.agents.map(a => [a.id, a.name]))))
      .catch(() => {});
  }, []);

  async function search() {
    const sha = commit.trim();
    if (!sha) return;
    setErr(null); setSearching(true);
    try {
      const r = await api.listAttestationsByCommit(sha);
      setRows(r.attestations); setSearched(sha);
    } catch (e) { setErr((e as Error).message); }
    finally { setSearching(false); }
  }

  async function rotate() {
    setRotateBusy(true); setErr(null);
    try { const r = await api.rotateSigningKey(); setKeyMsg(`New signing key: ${r.keyId}`); setRotateOpen(false); }
    catch (e) { setErr((e as Error).message); }
    finally { setRotateBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Commit signatures</h1>
        <p className="text-sm text-muted-foreground">
          A signed, verifiable record of how each commit was made — which model, prompt, and tools
          produced it, and whether tests/typecheck passed. Look one up by commit SHA to confirm it
          was made by the agent it claims, untampered.
        </p>
      </div>

      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      <Card>
        <CardHeader><CardTitle className="text-sm">Look up by commit SHA</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input placeholder="abc123…" value={commit} onChange={e => setCommit(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void search(); }} />
            <Button onClick={search} disabled={!commit.trim() || searching}>{searching ? "Searching…" : "Search"}</Button>
          </div>
        </CardContent>
      </Card>

      {searched === null ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          <FileSignature className="h-7 w-7 mx-auto mb-2 opacity-40" />
          Paste a commit SHA above to verify who made it and how.
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No commit signature found for <code className="font-mono">{searched.slice(0, 12)}</code>. The agent may not have signed this commit.
        </div>
      ) : (
      <div className="space-y-2">
        {rows.map(r => (
          <Card key={r.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                {r.verified ? <Badge>verified</Badge> : <Badge variant="destructive">invalid signature</Badge>}
                <code className="font-mono text-xs">{r.commitSha.slice(0, 7)}</code>
                {r.modelName && <span className="font-mono text-xs text-muted-foreground">{r.modelName}{r.modelVersion ? `@${r.modelVersion}` : ""}</span>}
                {r.agentVersion && <Badge variant="outline">v{r.agentVersion}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs font-mono space-y-1">
              <div>agent: {agentNames[r.agentId] ? `@${agentNames[r.agentId]}` : r.agentId.slice(0, 8)}</div>
              {r.framework && <div>framework: {r.framework}</div>}
              {r.promptHash && <div>prompt: {r.promptHash}</div>}
              <div>toolsUsed: {(r.toolsUsed ?? []).join(", ") || "—"}</div>
              <div>testsRun: {String(r.testsRun)} · typechecked: {String(r.typechecked)}</div>
              <div>signingKey: {r.signingKeyId}</div>
              {Object.keys(r.extra ?? {}).length > 0 && <pre className="text-xs bg-muted/40 p-2 rounded">{JSON.stringify(r.extra, null, 2)}</pre>}
            </CardContent>
          </Card>
        ))}
      </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">Signing key</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">ClawHub signs each attestation with the instance signing key. Rotating it mints a <strong>new</strong> key for future signatures; existing signatures stay verifiable under their original key id. Instance-wide.</p>
          {keyMsg && <Alert className="border-primary/30"><AlertDescription className="text-foreground text-xs">{keyMsg}</AlertDescription></Alert>}
          <Button variant="destructive" size="sm" onClick={() => setRotateOpen(true)}>Rotate signing key</Button>
        </CardContent>
      </Card>

      <Dialog open={rotateOpen} onOpenChange={v => { if (!v && !rotateBusy) setRotateOpen(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rotate the signing key?</DialogTitle></DialogHeader>
          <Alert variant="destructive">
            <TriangleAlert className="h-4 w-4" />
            <AlertDescription>Mints a new instance signing key. New attestations sign with it; existing ones stay verifiable under their original key id. This affects the whole instance.</AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="ghost" disabled={rotateBusy} onClick={() => setRotateOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={rotateBusy} onClick={rotate}>{rotateBusy ? "Rotating…" : "Rotate key"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
