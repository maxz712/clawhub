"use client";

import { useEffect, useState } from "react";
import { api, type User } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function UserSettingsPage() {
  const [me, setMe] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.getMe().then(setMe).catch(e => setError((e as Error).message)); }, []);

  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-3xl font-bold tracking-tight font-mono">Settings</h1>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <Card>
        <CardHeader><CardTitle className="text-sm">Account</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-2">
          {!me ? <div className="text-muted-foreground">Loading…</div> : (
            <>
              <div><span className="text-muted-foreground">Email:</span> {me.email}</div>
              {me.name && <div><span className="text-muted-foreground">Name:</span> {me.name}</div>}
            </>
          )}
        </CardContent>
      </Card>

      <TwoFactorCard />
      <GdprCard />
    </div>
  );
}

function GdprCard() {
  const [msg, setMsg] = useState<string | null>(null);
  const [download, setDownload] = useState<string | null>(null);

  async function exportData() {
    setMsg(null); setDownload(null);
    try {
      const { requestId } = await api.requestGdprExport();
      setMsg(`Requested export (${requestId}). Polling…`);
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        const r = await api.getGdprRequest(requestId);
        if (r.request.status === "ready" && r.request.downloadUrl) { setDownload(r.request.downloadUrl); setMsg("Ready."); return; }
        if (r.request.status === "failed") { setMsg(`Failed: ${r.request.downloadUrl}`); return; }
      }
      setMsg("Still processing; check back later.");
    } catch (e) { setMsg((e as Error).message); }
  }
  async function deleteAccount() {
    if (!confirm("This permanently deletes your ClawHub account. Continue?")) return;
    try { const { requestId } = await api.requestGdprDelete(); setMsg(`Deletion queued (${requestId}).`); }
    catch (e) { setMsg((e as Error).message); }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Data &amp; privacy (GDPR)</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        {msg && <div className="text-xs text-muted-foreground">{msg}</div>}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportData}>Export my data</Button>
          <Button variant="destructive" size="sm" onClick={deleteAccount}>Delete account</Button>
        </div>
        {download && (<a className="text-xs text-primary underline break-all" href={download} download="clawhub-export.json">Download export</a>)}
      </CardContent>
    </Card>
  );
}

function TwoFactorCard() {
  const [phase, setPhase] = useState<"idle" | "setup" | "verifying">("idle");
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function start() {
    try {
      const r = await api.setupTotp();
      setSecret(r.secret); setOtpauth(r.otpauth); setPhase("setup");
      setMsg(null);
    } catch (e) { setMsg((e as Error).message); }
  }
  async function verify() {
    setPhase("verifying");
    try {
      await api.verifyTotp(code);
      setMsg("2FA enabled.");
      setPhase("idle");
      setSecret(null); setOtpauth(null); setCode("");
    } catch (e) { setMsg((e as Error).message); setPhase("setup"); }
  }
  async function disable() {
    try { await api.disableTotp(code || undefined); setMsg("2FA disabled."); }
    catch (e) { setMsg((e as Error).message); }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Two-factor authentication (TOTP)</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {msg && <div className="text-xs text-muted-foreground">{msg}</div>}
        {phase === "idle" && (
          <div className="flex gap-2">
            <Button onClick={start}>Set up 2FA</Button>
            <Button variant="outline" onClick={disable}>Disable 2FA</Button>
          </div>
        )}
        {phase !== "idle" && secret && otpauth && (
          <>
            <div className="text-sm">Scan in your authenticator app, or copy the secret manually.</div>
            <div className="text-xs font-mono bg-muted/40 border border-border rounded p-2 break-all">{otpauth}</div>
            <div className="text-xs font-mono">Secret: <code>{secret}</code></div>
            <div>
              <Label>6-digit code</Label>
              <Input value={code} onChange={e => setCode(e.target.value)} maxLength={6} />
            </div>
            <Button onClick={verify}>Verify &amp; enable</Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
