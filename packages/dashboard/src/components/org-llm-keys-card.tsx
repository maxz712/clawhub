"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2, KeyRound } from "lucide-react";

/**
 * Org-connected LLM keys (N3 / the D2 fallback). An org pastes its OWN provider
 * key; ClawHub's metering gateway then forwards that org's platform-keyed runs
 * with it (sealed at rest, never in a container) — the org pays its provider
 * directly. The key is WRITE-ONLY (presence only is ever shown). Admins manage it.
 */
export function OrgLlmKeysCard({ orgId, isAdmin }: { orgId: string; isAdmin: boolean }) {
  const [keys, setKeys] = useState<Array<{ provider: string; baseUrl: string | null; updatedAt: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // N3 org provider allowlist: which qualified hosts this org permits (comma-
  // separated OpenRouter provider slugs; empty = every qualified catalog host).
  const [allowlist, setAllowlist] = useState("");
  const [allowSaved, setAllowSaved] = useState(false);

  async function load() {
    try {
      setKeys((await api.listOrgLlmKeys(orgId)).keys);
      const a = await api.getOrgLlmProviders(orgId).catch(() => ({ allowlist: null }));
      setAllowlist((a.allowlist ?? []).join(", "));
    }
    catch (e) { setError((e as Error).message); }
    finally { setLoaded(true); }
  }

  async function saveAllowlist() {
    setError(null); setAllowSaved(false);
    try {
      const list = allowlist.split(",").map(x => x.trim()).filter(Boolean);
      await api.setOrgLlmProviders(orgId, list.length ? list : null);
      setAllowSaved(true);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [orgId]);

  async function save() {
    setPending(true); setSaved(false); setError(null);
    try {
      await api.setOrgLlmKey(orgId, provider, key.trim(), baseUrl.trim() || undefined);
      setKey(""); setBaseUrl(""); setSaved(true);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }
  async function remove(p: string) {
    setError(null);
    try { await api.deleteOrgLlmKey(orgId, p); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  if (!loaded) return null;

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-1.5"><KeyRound className="h-4 w-4" /> Connected LLM keys</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {error && <Alert variant="destructive"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}
        <p className="text-xs text-muted-foreground">
          Use this org&apos;s OWN provider key for its platform reviews + verifies. The gateway forwards with your key
          (sealed at rest, never inside a container) — you pay your provider directly, so these runs aren&apos;t billed as
          ClawHub overage.
        </p>
        {keys.length > 0 ? (
          <ul className="space-y-1">
            {keys.map(k => (
              <li key={k.provider} className="flex items-center justify-between rounded border border-border px-2 py-1.5 text-sm">
                <span className="font-mono uppercase text-xs">{k.provider}{k.baseUrl ? <span className="text-muted-foreground normal-case"> · {k.baseUrl}</span> : null}</span>
                {isAdmin && <Button size="sm" variant="ghost" className="h-6 text-destructive" onClick={() => void remove(k.provider)}>Remove</Button>}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-muted-foreground">No connected key — platform runs use ClawHub&apos;s key (metered/billed normally).</p>}
        {isAdmin && (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-end gap-2 flex-wrap">
              <div>
                <Label className="text-xs">Provider</Label>
                <select value={provider} onChange={e => { setProvider(e.target.value as "openai" | "anthropic"); setSaved(false); }}
                  className="block h-9 rounded-md border border-border bg-background px-2 text-sm">
                  <option value="openai">OpenAI / OpenRouter</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </div>
              <div className="flex-1 min-w-[220px]">
                <Label className="text-xs">API key (write-only)</Label>
                <Input type="password" value={key} onChange={e => { setKey(e.target.value); setSaved(false); }} placeholder="sk-…" autoComplete="off" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Base URL (optional override)</Label>
              <Input value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setSaved(false); }} placeholder="https://openrouter.ai/api/v1" />
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => void save()} disabled={pending || key.trim().length < 8}>{pending ? "Saving…" : "Connect key"}</Button>
              {saved && <span className="flex items-center gap-1 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" /> Saved</span>}
            </div>
            <div className="space-y-1 border-t border-border pt-3">
              <Label className="text-xs">Provider allowlist</Label>
              <Input value={allowlist} onChange={e => { setAllowlist(e.target.value); setAllowSaved(false); }} placeholder="deepinfra, fireworks (empty = every qualified host)" />
              <p className="text-[11px] text-muted-foreground">
                Narrow which qualified US hosts this org&apos;s platform runs may route to (compliance posture — it can narrow the catalog pin, never widen it).
              </p>
              <div className="flex items-center gap-3">
                <Button size="sm" variant="outline" onClick={() => void saveAllowlist()}>Save allowlist</Button>
                {allowSaved && <span className="flex items-center gap-1 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" /> Saved</span>}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
