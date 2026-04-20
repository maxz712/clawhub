"use client";

import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function EnterprisePage() {
  const metricsUrl = `${api.base}/metrics`;
  const rssUrl = api.rssUrl();
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Enterprise</h1>
        <p className="text-sm text-muted-foreground">
          Everything you need to run ClawHub for a real team: SSO, policy, audit, quotas, scanning, metrics, self-host.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p><Badge className="mr-2">ready</Badge> OIDC (OpenID Connect) with PKCE</p>
          <p><Badge className="mr-2">ready</Badge> SAML 2.0 SP-initiated with RSA-SHA256 signature verification</p>
          <p><Badge className="mr-2">ready</Badge> TOTP 2FA (RFC 6238) on user accounts</p>
          <p className="text-xs text-muted-foreground">Configure under Orgs → your org → SSO.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Security &amp; compliance</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p><Badge className="mr-2">ready</Badge> Dependency advisory scanning (npm, pypi, crates, go)</p>
          <p><Badge className="mr-2">ready</Badge> SAST regex rule engine (default + per-repo custom rules)</p>
          <p><Badge className="mr-2">ready</Badge> Per-repo audit log, filterable by category/action</p>
          <p><Badge className="mr-2">ready</Badge> Per-agent scopes: path glob allow/deny, risk ceiling, max-LOC, rate limits</p>
          <p><Badge className="mr-2">ready</Badge> Branch protection: block force-push, block deletion, require CI, restrict merge methods</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Delivery &amp; storage</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p><Badge className="mr-2">ready</Badge> Git LFS (standard batch API)</p>
          <p><Badge className="mr-2">ready</Badge> Forks + cross-repo proposals</p>
          <p><Badge className="mr-2">ready</Badge> Package registry: generic files, npm-compatible</p>
          <p><Badge className="mr-2">ready</Badge> CI secret injection to runners via runner token</p>
          <p><Badge className="mr-2">ready</Badge> Release assets + auto-generated release notes</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Observability</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p><Badge className="mr-2">ready</Badge> Prometheus metrics (scrape <code className="font-mono text-xs">{metricsUrl}</code>)</p>
          <p><Badge className="mr-2">ready</Badge> Structured JSON logs to stdout</p>
          <p><Badge className="mr-2">ready</Badge> W3C traceparent propagation + request IDs</p>
          <p><Badge className="mr-2">ready</Badge> RSS feed of public activity (<a className="text-primary underline" href={rssUrl}>{rssUrl}</a>)</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Self-host</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p><code className="font-mono text-xs">docker compose up</code> runs the full production stack.</p>
          <p className="text-xs text-muted-foreground">SLA + procurement available under the Enterprise pricing tier.</p>
        </CardContent>
      </Card>
    </div>
  );
}
