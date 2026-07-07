"use client";

import { useEffect, useState } from "react";
import { api, type LlmKeyRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Key, Plus, Trash2 } from "lucide-react";

// The BYO LLM key vault (v4). Keys are sealed at rest server-side; the API
// never returns plaintext, so this page renders name/provider/createdAt only.

const PROVIDERS = ["anthropic", "openai", "google", "openrouter", "other"];

export default function KeysPage() {
  const [keys, setKeys] = useState<LlmKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add form.
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<LlmKeyRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    try { setKeys((await api.listLlmKeys()).keys); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  async function addKey() {
    setBusy(true); setError(null);
    try {
      await api.createLlmKey({ name: name.trim() || "My key", provider, key: value.trim() });
      setName(""); setValue("");
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function doDelete() {
    if (!confirmDelete) return;
    setDeleting(true); setError(null);
    try { await api.deleteLlmKey(confirmDelete.id); setConfirmDelete(null); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setDeleting(false); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Keys</h1>
        <p className="text-muted-foreground mt-1">
          Bring-your-own LLM keys, sealed at rest. Any number of deployments can share one key; deleting a key
          never bricks a running deployment (they hold their own sealed copy).
        </p>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {/* Add a key */}
      <Card>
        <CardContent className="pt-5">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_10rem_1.4fr_auto] gap-2 items-end">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="My Anthropic key" className="mt-1.5" />
            </div>
            <div>
              <Label>Provider</Label>
              <Select value={provider} onValueChange={v => setProvider(v ?? "anthropic")}>
                <SelectTrigger className="w-full mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Key</Label>
              <Input type="password" value={value} onChange={e => setValue(e.target.value)} placeholder="sk-… or sk-ant-oat…" className="mt-1.5 font-mono" />
            </div>
            <Button className="gap-2" disabled={busy || !value.trim()} onClick={addKey}>
              <Plus className="h-4 w-4" /> {busy ? "Adding…" : "Add key"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            An API key — or a Claude subscription token (<code className="font-mono">sk-ant-oat…</code> from <code className="font-mono">claude setup-token</code>); both work in this one field.
          </p>
        </CardContent>
      </Card>

      {/* The vault */}
      {!keys ? <div className="text-muted-foreground">Loading…</div>
        : keys.length === 0 ? (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            No keys yet. Add one above — deployments pick it from a dropdown when you create them.
          </div>
        ) : (
          <div className="space-y-2">
            {keys.map(k => (
              <div key={k.id} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <Key className="h-4 w-4 text-primary shrink-0" />
                <span className="font-medium truncate">{k.name}</span>
                <Badge variant="secondary" className="text-[10px]">{k.provider}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">added {new Date(k.createdAt).toLocaleDateString()}</span>
                <Button variant="ghost" size="sm" className="h-9 w-9 sm:h-7 sm:w-7 shrink-0" title={`Delete key “${k.name}”`} onClick={() => setConfirmDelete(k)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

      {/* Confirm delete */}
      <Dialog open={!!confirmDelete} onOpenChange={v => { if (!v && !deleting) setConfirmDelete(null); }}>
        <DialogContent>
          {confirmDelete && (
            <>
              <DialogHeader><DialogTitle>Delete key “{confirmDelete.name}”?</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">
                Removes it from the vault, so no NEW deployment can pick it. Running deployments keep their own
                sealed copy and are unaffected.
              </p>
              <DialogFooter>
                <Button variant="ghost" disabled={deleting} onClick={() => setConfirmDelete(null)}>Cancel</Button>
                <Button variant="destructive" disabled={deleting} onClick={doDelete}>{deleting ? "Deleting…" : "Delete key"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
