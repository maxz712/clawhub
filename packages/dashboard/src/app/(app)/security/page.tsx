"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function SecurityHubPage() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [advJson, setAdvJson] = useState("");
  // The global control plane (seed-all-repos SAST rules, global advisory ingest)
  // is a PLATFORM-operator chore — the server now gates both endpoints on
  // platform admin (CLAWHUB_ADMIN_EMAILS). Gate the UI on the SAME signal so the
  // affordance matches what the server actually permits (not an unrelated proxy).
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    api.getAdminStatus()
      .then(r => setIsAdmin(r.isAdmin))
      .catch(() => setIsAdmin(false));
  }, []);

  async function seed() {
    setMsg(null); setErr(null);
    try { const r = await api.seedSastDefaults(); setMsg(`Seeded ${r.seeded} rules.`); }
    catch (e) { setErr((e as Error).message); }
  }

  async function uploadAdvisories() {
    setMsg(null); setErr(null);
    try {
      const parsed = JSON.parse(advJson) as Parameters<typeof api.uploadAdvisories>[0];
      const r = await api.uploadAdvisories(parsed);
      setMsg(`Inserted ${r.inserted} advisory records.`);
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Security</h1>
        <p className="text-sm text-muted-foreground">SAST rules + dependency advisory control plane. Per-repo findings live under each repo&apos;s Security tab.</p>
      </div>

      {msg && <Alert><AlertDescription>{msg}</AlertDescription></Alert>}
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      {isAdmin === false && (
        <p className="text-sm text-muted-foreground">
          Global SAST-rule seeding + advisory ingestion is a platform-admin control plane (default rules are already seeded automatically). Per-repo security findings appear on each repo&apos;s Security tab.
        </p>
      )}

      {isAdmin && (
        <>
          <Card>
            <CardHeader><CardTitle className="text-sm">SAST defaults</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-muted-foreground">Seed a curated default ruleset (AWS keys, eval, SQL concat, weak hashes, etc.) for all repos.</p>
              <Button onClick={seed} size="sm">Seed default rules</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Dependency advisories</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">Paste advisories as JSON (array). Each object: {`{ identifier, ecosystem, packageName, vulnerableRange, patchedRange, severity, summary, url }`}.</p>
              <Textarea value={advJson} onChange={e => setAdvJson(e.target.value)} rows={10} className="font-mono text-xs" placeholder='[{"identifier":"CVE-2024-00001","ecosystem":"npm","packageName":"lodash","vulnerableRange":"<4.17.21","severity":"high","summary":"Prototype pollution"}]' />
              <Button onClick={uploadAdvisories} size="sm">Upload</Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
