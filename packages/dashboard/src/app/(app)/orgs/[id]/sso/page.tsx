"use client";

import { use, useEffect, useState } from "react";
import { api, type SsoProvider } from "@/lib/api";
import { useEeFeature } from "@/lib/edition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function OrgSsoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const hasSaml = useEeFeature("sso-saml");
  const [rows, setRows] = useState<SsoProvider[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<"oidc" | "saml">("oidc");
  const [name, setName] = useState("");
  const [config, setConfig] = useState("{}");

  async function load() { try { const r = await api.listSsoProviders(id); setRows(r.providers); } catch (e) { setErr((e as Error).message); } }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function create() {
    setErr(null);
    try {
      const cfg = JSON.parse(config);
      await api.createSsoProvider(id, { name, kind, config: cfg });
      setName(""); setConfig("{}");
      void load();
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">SSO (Org {id})</h1>
        <p className="text-sm text-muted-foreground">Configure OIDC or SAML so your team signs in via corporate identity.</p>
      </div>

      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

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
                {hasSaml && <SelectItem value="saml">SAML 2.0</SelectItem>}
              </SelectContent>
            </Select>
            {!hasSaml && kind === "oidc" && (
              <p className="text-xs text-muted-foreground">SAML 2.0 is a cloud/enterprise feature. OIDC works on all editions.</p>
            )}
          </div>
          <div>
            <Label>Config (JSON)</Label>
            <Textarea rows={10} className="font-mono text-xs" value={config} onChange={e => setConfig(e.target.value)}
              placeholder={kind === "oidc"
                ? '{"issuer":"https://accounts.google.com","clientId":"...","clientSecret":"...","redirectUri":"https://clawhub.dev/api/v1/sso/oidc/callback"}'
                : '{"entityId":"clawhub","ssoUrl":"https://idp.example.com/saml/sso","x509cert":"-----BEGIN CERTIFICATE-----\\nMII...\\n-----END CERTIFICATE-----","acsUrl":"https://clawhub.dev/api/v1/sso/saml/acs"}'} />
          </div>
          <Button onClick={create}>Add provider</Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {rows.map(p => (
          <Card key={p.id}>
            <CardContent className="pt-4 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{p.kind}</Badge>
                  <span className="font-semibold">{p.name}</span>
                  {!p.enabled && <Badge variant="secondary">disabled</Badge>}
                </div>
                <div className="text-xs font-mono text-muted-foreground mt-1 break-all">Login URL: {api.ssoLoginUrl(p.id, p.kind)}</div>
              </div>
              <Button size="sm" variant="outline" onClick={async () => { await api.deleteSsoProvider(id, p.id); void load(); }}>Delete</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
