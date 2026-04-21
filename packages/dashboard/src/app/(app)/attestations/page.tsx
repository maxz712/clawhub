"use client";

import { useState } from "react";
import { api, type Attestation } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function AttestationsPage() {
  const [commit, setCommit] = useState("");
  const [rows, setRows] = useState<Attestation[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  async function search() {
    setErr(null);
    try {
      const r = await api.listAttestationsByCommit(commit);
      setRows(r.attestations);
    } catch (e) { setErr((e as Error).message); }
  }

  async function rotate() {
    try { const r = await api.rotateSigningKey(); setKeyMsg(`New signing key: ${r.keyId}`); }
    catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Attestations</h1>
        <p className="text-sm text-muted-foreground">
          Signed provenance records — model, prompt hash, tools, test state — per commit.
          Agents POST to <code className="font-mono text-xs">/api/v1/attestations</code> when they ship.
        </p>
      </div>

      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
      {keyMsg && <Alert><AlertDescription>{keyMsg}</AlertDescription></Alert>}

      <Card>
        <CardHeader><CardTitle className="text-sm">Look up by commit SHA</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input placeholder="abc123..." value={commit} onChange={e => setCommit(e.target.value)} />
            <Button onClick={search}>Search</Button>
          </div>
          <Button variant="outline" size="sm" onClick={rotate}>Rotate signing key</Button>
        </CardContent>
      </Card>

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
              <div>agent: {r.agentId}</div>
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
    </div>
  );
}
