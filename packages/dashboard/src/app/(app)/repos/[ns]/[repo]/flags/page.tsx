"use client";

import { use, useEffect, useState } from "react";
import { api, type FlagRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function FlagsPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [flags, setFlags] = useState<FlagRow[] | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try { const r = await api.listRepoFlags(ns, repo); setFlags(r.flags); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ns, repo]);

  async function create() {
    if (!key) return;
    setError(null);
    try {
      await api.upsertRepoFlag(ns, repo, key, { enabled: false, rolloutPercent: 0 });
      setKey("");
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function update(f: FlagRow, patch: { enabled?: boolean; rolloutPercent?: number }) {
    setError(null);
    try { await api.upsertRepoFlag(ns, repo, f.key, patch); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Feature flags</h1>
        <p className="text-sm text-muted-foreground">Percentage rollouts + rule overrides. Agents evaluate via <code className="font-mono text-xs">/api/v1/flags/evaluate</code>.</p>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <Card>
        <CardHeader><CardTitle className="text-sm">New flag</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          <Input placeholder="new-focused-diff" value={key} onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void create(); }} />
          <Button onClick={create}>Create</Button>
        </CardContent>
      </Card>

      {flags === null
        ? <div className="text-sm text-muted-foreground">Loading…</div>
        : flags.length === 0
          ? <div className="py-12 text-center text-sm text-muted-foreground">No feature flags yet. Create one above.</div>
          : (
            <div className="space-y-2">
              {flags.map(f => <FlagRowCard key={f.id} flag={f} onUpdate={update} />)}
            </div>
          )}
    </div>
  );
}

/**
 * One flag row. The rollout input edits LOCAL draft state and only writes on
 * blur (or Enter) — previously every keystroke fired an API write. The on/off
 * control's label and badge are kept consistent (both read "on"/"off").
 */
function FlagRowCard({ flag, onUpdate }: { flag: FlagRow; onUpdate: (f: FlagRow, patch: { enabled?: boolean; rolloutPercent?: number }) => Promise<void> }) {
  const [draft, setDraft] = useState(String(flag.rolloutPercent));

  // Keep the draft in sync when the persisted value changes (e.g. after reload).
  useEffect(() => { setDraft(String(flag.rolloutPercent)); }, [flag.rolloutPercent]);

  function commit() {
    const next = Math.max(0, Math.min(100, Number(draft) || 0));
    setDraft(String(next));
    if (next !== flag.rolloutPercent) void onUpdate(flag, { rolloutPercent: next });
  }

  return (
    <Card>
      <CardContent className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-4">
        <div>
          <div className="font-mono font-semibold">{flag.key}</div>
          <div className="text-xs text-muted-foreground">Rollout {flag.rolloutPercent}%{flag.enabled ? "" : " · disabled"}</div>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs">Rollout %</Label>
          <Input
            type="number"
            min={0}
            max={100}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); } }}
            className="w-24"
          />
        </div>
        <Button variant={flag.enabled ? "default" : "outline"} size="sm" className="gap-1.5" onClick={() => void onUpdate(flag, { enabled: !flag.enabled })}>
          {flag.enabled ? <Badge className="px-1.5 py-0">on</Badge> : <span>off</span>}
        </Button>
      </CardContent>
    </Card>
  );
}
