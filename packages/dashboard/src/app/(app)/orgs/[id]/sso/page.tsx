"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, type SsoProvider } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

const OIDC_CALLBACK = (base: string) => `${base}/api/v1/sso/oidc/callback`;
const SAML_ACS = (base: string) => `${base}/api/v1/sso/saml/acs`;

// Read-only field with a copy button — the values an IdP admin pastes into their
// console (ACS, redirect, metadata).
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex gap-2 items-center">
        <Input readOnly value={value} className="font-mono text-xs" onFocus={e => e.currentTarget.select()} />
        <Button
          type="button" size="sm" variant="outline"
          onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ } }}
        >{copied ? "Copied" : "Copy"}</Button>
      </div>
    </div>
  );
}

export default function OrgSsoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rows, setRows] = useState<SsoProvider[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState(false);
  const [trialMsg, setTrialMsg] = useState<string | null>(null);
  const [kind, setKind] = useState<"oidc" | "saml">("oidc");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  // OIDC fields
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  // SAML fields
  const [entityId, setEntityId] = useState("clawhub");
  const [ssoUrl, setSsoUrl] = useState("");
  const [x509cert, setX509cert] = useState("");

  async function load() {
    try { const r = await api.listSsoProviders(id); setRows(r.providers); }
    catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  function resetForm() {
    setName(""); setIssuer(""); setClientId(""); setClientSecret("");
    setEntityId("clawhub"); setSsoUrl(""); setX509cert("");
  }

  async function create() {
    setErr(null); setUpgrade(false); setTrialMsg(null);
    const config = kind === "oidc"
      ? { issuer, clientId, clientSecret, redirectUri: OIDC_CALLBACK(api.base) }
      : { entityId, ssoUrl, x509cert, acsUrl: SAML_ACS(api.base) };
    setBusy(true);
    try {
      await api.createSsoProvider(id, { name, kind, config });
      resetForm();
      await load();
    } catch (e) {
      // Team+ entitlement gate — surface a dedicated upgrade prompt instead of a raw 403.
      if (e instanceof ApiError && e.code === "upgrade_required") setUpgrade(true);
      else setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function startTrial() {
    setErr(null); setTrialMsg(null);
    try {
      await api.startOrgTrial(id);
      setUpgrade(false);
      setTrialMsg("Trial started — try adding your provider again.");
    } catch (e) { setErr((e as Error).message); }
  }

  async function remove(p: SsoProvider) {
    if (!window.confirm(`Delete the "${p.name}" ${p.kind.toUpperCase()} provider? Members using it will lose this sign-in path.`)) return;
    setErr(null);
    try { await api.deleteSsoProvider(id, p.id); await load(); }
    catch (e) { setErr((e as Error).message); }
  }

  const canSubmit = name.trim().length > 0 &&
    (kind === "oidc" ? issuer && clientId && clientSecret : ssoUrl && x509cert);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">SSO (Org {id})</h1>
        <p className="text-sm text-muted-foreground">Configure OIDC or SAML so your team signs in via corporate identity. Requires a Team plan or higher.</p>
      </div>

      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
      {trialMsg && <Alert><AlertDescription>{trialMsg}</AlertDescription></Alert>}

      {upgrade && (
        <Card className="border-primary/40">
          <CardHeader><CardTitle className="text-sm">SSO requires a Team plan</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              SAML / OIDC single sign-on is a Team-and-up feature. Upgrade this org, or start a trial to evaluate it.
            </p>
            <div className="flex gap-2">
              <Link href="/pricing" className={buttonVariants({ size: "sm" })}>View plans</Link>
              <Button size="sm" variant="outline" onClick={startTrial}>Start trial</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">Add provider</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="Okta, Google, etc." /></div>
          <div>
            <Label>Kind</Label>
            <Select value={kind} onValueChange={v => setKind((v ?? "oidc") as "oidc" | "saml")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="oidc">OIDC (OpenID Connect)</SelectItem>
                <SelectItem value="saml">SAML 2.0</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {kind === "oidc" ? (
            <>
              <div><Label>Issuer URL</Label><Input className="font-mono text-xs" value={issuer} onChange={e => setIssuer(e.target.value)} placeholder="https://accounts.google.com" /></div>
              <div><Label>Client ID</Label><Input className="font-mono text-xs" value={clientId} onChange={e => setClientId(e.target.value)} placeholder="123…apps.googleusercontent.com" /></div>
              <div><Label>Client Secret</Label><Input type="password" className="font-mono text-xs" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder="GOCSPX-…" /></div>
              <div className="pt-1 border-t border-border space-y-2">
                <p className="text-xs text-muted-foreground">Set this as the redirect / callback URL in your IdP:</p>
                <CopyField label="Redirect URI" value={OIDC_CALLBACK(api.base)} />
              </div>
            </>
          ) : (
            <>
              <div><Label>Entity ID (SP)</Label><Input className="font-mono text-xs" value={entityId} onChange={e => setEntityId(e.target.value)} placeholder="clawhub" /></div>
              <div><Label>IdP SSO URL</Label><Input className="font-mono text-xs" value={ssoUrl} onChange={e => setSsoUrl(e.target.value)} placeholder="https://idp.example.com/saml/sso" /></div>
              <div><Label>IdP x509 certificate (PEM)</Label><textarea rows={6} className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs" value={x509cert} onChange={e => setX509cert(e.target.value)} placeholder={"-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----"} /></div>
              <div className="pt-1 border-t border-border space-y-2">
                <p className="text-xs text-muted-foreground">Configure these in your IdP:</p>
                <CopyField label="ACS URL (Reply URL)" value={SAML_ACS(api.base)} />
                <CopyField label="Audience / Entity ID" value={entityId || "clawhub"} />
              </div>
            </>
          )}

          <Button onClick={create} disabled={busy || !canSubmit}>{busy ? "Adding…" : "Add provider"}</Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No SSO providers configured yet.</p>}
        {rows.map(p => (
          <Card key={p.id}>
            <CardContent className="pt-4 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{p.kind}</Badge>
                  <span className="font-semibold">{p.name}</span>
                  {!p.enabled && <Badge variant="secondary">disabled</Badge>}
                </div>
                <div className="text-xs font-mono text-muted-foreground mt-1 break-all">Login URL: {api.ssoLoginUrl(p.id)}</div>
              </div>
              <Button size="sm" variant="outline" onClick={() => remove(p)}>Delete</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
