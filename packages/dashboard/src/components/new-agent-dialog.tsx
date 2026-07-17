"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, type AccessRoleRow, type ByoModelOption, type LlmCatalogModel, type LlmKeyRow, type Repo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CopyBlock } from "@/components/copy-block";
import { Textarea } from "@/components/ui/textarea";

// v4 (docs/redesign-v4.md): creating an agent is IDENTITY ONLY — name + access
// role + where it runs + (for deployed) which LLM. Deployments are repo-less;
// repos, instructions and cadence belong to WORKFLOWS (/agents/workflows),
// which the success screen points at. No container knobs anywhere.

const NEW_KEY = "__new__";
const NEW_ROLE = "__new_role__";

export function NewAgentDialog({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void;
}) {
  const [roles, setRoles] = useState<AccessRoleRow[] | null>(null);
  const [keys, setKeys] = useState<LlmKeyRow[] | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);

  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [run, setRun] = useState<"local" | "deployed">("local");
  // LLM provider choice for deployed agents: platform-metered or BYO key.
  const [llmChoice, setLlmChoice] = useState<"platform" | "byo">("platform");
  const [keyChoice, setKeyChoice] = useState<string>("");
  const [catalog, setCatalog] = useState<LlmCatalogModel[] | null>(null);
  const [model, setModel] = useState<string>("");
  // #72 — models selectable for the CHOSEN byo key, auto-detected from its provider.
  const [byoModels, setByoModels] = useState<ByoModelOption[] | null>(null);
  const [task, setTask] = useState("");

  // Inline "add key" mini-form — creates the key in the vault, then selects it.
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyProvider, setNewKeyProvider] = useState("anthropic");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);

  // Inline "new role" mini-form. The simple checkboxes map to v3 permission
  // ARRAYS on submit (docs/redesign-v3.md §2) — push/review/merge are the
  // common-case bundles; the full grouped picker lives on /roles.
  const [newRoleName, setNewRoleName] = useState("");
  const [newRolePush, setNewRolePush] = useState(true);
  const [newRoleReview, setNewRoleReview] = useState(true);
  const [newRoleMerge, setNewRoleMerge] = useState(false);
  const [newRoleScope, setNewRoleScope] = useState<"all" | "selected">("all");
  const [newRoleRepoIds, setNewRoleRepoIds] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);
  const [createdRun, setCreatedRun] = useState<"local" | "deployed">("local");

  useEffect(() => {
    if (!open) return;
    api.listAccessRoles().then(r => {
      setRoles(r.roles);
      // Preselect the Developer default so the happy path is two fields.
      if (!roleId && r.roles.length) setRoleId((r.roles.find(x => x.name === "Developer") ?? r.roles[0]).id);
    }).catch(e => setError((e as Error).message));
    api.listLlmKeys().then(r => setKeys(r.keys)).catch(() => setKeys([]));
    api.listRepos().then(r => setRepos(r.repos)).catch(() => setRepos([]));
    api.getLlmCatalog().then(r => setCatalog(r.models)).catch(() => setCatalog([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // #72 — the model dropdown below the key dropdown is scoped to whichever
  // key is currently selected; switching keys re-detects the options and
  // drops a model that no longer applies.
  useEffect(() => {
    setModel("");
    if (llmChoice !== "byo" || !keyChoice || keyChoice === NEW_KEY) { setByoModels(null); return; }
    let cancelled = false;
    api.getLlmKeyModels(keyChoice).then(r => { if (!cancelled) setByoModels(r.models); }).catch(() => { if (!cancelled) setByoModels([]); });
    return () => { cancelled = true; };
  }, [llmChoice, keyChoice]);

  // Deployments run the agentic harness loop — only clean tool-callers
  // qualify (mirrors the server's `model_not_agentic` 400).
  const modelOptions = useMemo(() => (catalog ?? []).filter(m => m.agentic !== false), [catalog]);
  const modelsWereFiltered = (catalog?.length ?? 0) > modelOptions.length;

  async function addKeyInline() {
    setKeyBusy(true); setError(null);
    try {
      const created = await api.createLlmKey({ name: newKeyName.trim() || "My key", provider: newKeyProvider, key: newKeyValue.trim() });
      const r = await api.listLlmKeys().catch(() => ({ keys: [created.key] }));
      setKeys(r.keys);
      setKeyChoice(created.key.id);
      setNewKeyName(""); setNewKeyValue("");
    } catch (e) { setError((e as Error).message); }
    finally { setKeyBusy(false); }
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      let effectiveRoleId = roleId;
      if (roleId === NEW_ROLE) {
        const permissions: string[] = [];
        if (newRolePush) permissions.push("repo:read", "repo:write", "change:write", "issue:write", "workflow:trigger");
        if (newRoleReview) permissions.push("change:review");
        if (newRoleMerge) permissions.push("change:merge");
        const created = await api.createAccessRole({
          name: newRoleName.trim() || "Custom role",
          permissions,
          repoScope: newRoleScope, repoIds: newRoleScope === "selected" ? newRoleRepoIds : [],
        });
        effectiveRoleId = created.role.id;
      }
      // v4: identity only — no repoIds / instructions / cadence. Workflows own those.
      const res = await api.createManagedAgent({
        name: name.trim(), accessRoleId: effectiveRoleId, run,
        keySource: run === "deployed" && llmChoice === "platform" ? "platform" : undefined,
        llmKeyId: run === "deployed" && llmChoice === "byo" ? keyChoice : undefined,
        model: run === "deployed" && model ? model : undefined,
        task: run === "deployed" && task.trim() ? task.trim() : undefined,
      });
      setCreatedName(res.agent.name);
      setCreatedRun(run);
      if (res.token) setCreatedToken(res.token);
      onCreated();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function reset() {
    setCreatedToken(null); setCreatedName(null); setName(""); setError(null);
    setRun("local"); setLlmChoice("platform"); setKeyChoice(""); setModel("");
    setNewKeyName(""); setNewKeyValue(""); setTask("");
  }

  const canSubmit = Boolean(
    name.trim() &&
    (roleId && (roleId !== NEW_ROLE || newRoleName.trim())) &&
    (run === "local" || llmChoice === "platform" || (keyChoice && keyChoice !== NEW_KEY)),
  );

  const apiBase = api.base;

  return (
    <Dialog open={open} onOpenChange={v => { if (!busy) { onOpenChange(v); if (!v) reset(); } }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{createdName ? `${createdName} created` : "New agent"}</DialogTitle></DialogHeader>

        {createdName ? (
          <div className="space-y-3">
            {createdToken ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Paste this token into the tool that runs the agent (Claude Code, Cursor, a script). It is shown <strong>once</strong> — rotate it from the agent page if you lose it.
                </p>
                <CopyBlock value={createdToken} />
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground pt-1">Push as this agent</p>
                <CopyBlock value={`git remote add clawhub ${apiBase.replace(/^(https?):\/\//, `$1://agent-token:${createdToken}@`)}/<you>/<repo>.git`} />
              </>
            ) : createdRun === "deployed" ? (
              <p className="text-sm text-muted-foreground">
                Deployed. ClawHub holds its credentials — nothing to paste. Give it work in the{" "}
                <Link href="/agents/workflows" className="text-primary hover:underline" onClick={() => { onOpenChange(false); reset(); }}>Workflows tab</Link>{" "}
                — a workflow is instructions + a cadence + an optional repo scope.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Created.</p>
            )}
            <DialogFooter><Button onClick={() => { onOpenChange(false); reset(); }}>Done</Button></DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

            <div>
              <Label>Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="pair-programmer" className="mt-1.5" />
            </div>

            <div>
              <Label>Role — what it may do</Label>
              <Select value={roleId} onValueChange={v => setRoleId(v ?? "")}>
                <SelectTrigger className="w-full mt-1.5">
                  <SelectValue>{(v: string) => v === NEW_ROLE ? "New role…" : (roles?.find(r => r.id === v)?.name ?? "Pick a role")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(roles ?? []).map(r => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}{r.description ? ` — ${r.description}` : ""}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_ROLE}>New role…</SelectItem>
                </SelectContent>
              </Select>
              {roleId === NEW_ROLE && (
                <div className="mt-2 space-y-2 rounded-md border border-border/60 p-3">
                  <Input value={newRoleName} onChange={e => setNewRoleName(e.target.value)} placeholder="Role name (e.g. Docs-only developer)" />
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" className="accent-primary" checked={newRolePush} onChange={e => setNewRolePush(e.target.checked)} /> Can push code</label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" className="accent-primary" checked={newRoleReview} onChange={e => setNewRoleReview(e.target.checked)} /> Can review</label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" className="accent-primary" checked={newRoleMerge} onChange={e => setNewRoleMerge(e.target.checked)} /> Can merge (any risk, policy permitting)</label>
                  </div>
                  {newRoleMerge && (
                    <p className="text-xs text-yellow-500">Merge rights are uniform — this grants merging to the agent itself, at any risk the repo&apos;s policy permits.</p>
                  )}
                  <div className="flex gap-4 text-sm">
                    <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="role-scope" className="accent-primary" checked={newRoleScope === "all"} onChange={() => setNewRoleScope("all")} /> All my repos</label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="role-scope" className="accent-primary" checked={newRoleScope === "selected"} onChange={() => setNewRoleScope("selected")} /> Selected repos</label>
                  </div>
                  {newRoleScope === "selected" && (
                    <div className="max-h-32 overflow-y-auto space-y-1">
                      {(repos ?? []).map(r => (
                        <label key={r.id} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="checkbox" className="accent-primary" checked={newRoleRepoIds.includes(r.id)}
                            onChange={e => setNewRoleRepoIds(ids => e.target.checked ? [...ids, r.id] : ids.filter(x => x !== r.id))} />
                          <span className="font-mono text-xs">{r.namespaceName}/{r.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <Label>Runs</Label>
              <div className="mt-1.5 flex gap-4 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="run" className="accent-primary" checked={run === "local"} onChange={() => setRun("local")} />
                  I run it myself (get a token)
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="run" className="accent-primary" checked={run === "deployed"} onChange={() => setRun("deployed")} />
                  ClawHub runs it
                </label>
              </div>
            </div>

            {run === "deployed" && (
              <div>
                <Label>LLM</Label>
                <div className="mt-1.5 flex gap-4 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="llm" className="accent-primary" checked={llmChoice === "platform"} onChange={() => setLlmChoice("platform")} />
                    Platform (metered)
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="llm" className="accent-primary" checked={llmChoice === "byo"} onChange={() => setLlmChoice("byo")} />
                    Bring your own key
                  </label>
                </div>

                {llmChoice === "platform" && (catalog?.length ?? 0) > 0 && (
                  <div className="mt-2">
                    <Label>Model</Label>
                    <Select value={model || "__auto__"} onValueChange={v => setModel(v === "__auto__" ? "" : (v ?? ""))}>
                      <SelectTrigger className="w-full mt-1.5">
                        <SelectValue>{(v: string) => v === "__auto__" ? "Auto (routed by task)" : v}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__auto__">Auto (routed by task)</SelectItem>
                        {modelOptions.map(m => <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-xs text-muted-foreground">Qualified catalog only — every model is pinned to a named US host with data collection denied.</p>
                    {modelsWereFiltered && (
                      <p className="mt-1 text-xs text-muted-foreground">Single-shot models (e.g. DeepSeek) are hidden — a deployment runs the agentic tool loop.</p>
                    )}
                  </div>
                )}

                {llmChoice === "byo" && (
                  <div className="mt-2">
                    <Select value={keyChoice} onValueChange={v => setKeyChoice(v ?? "")}>
                      <SelectTrigger className="w-full">
                        <SelectValue>{(v: string) => v === NEW_KEY ? "Add a new key…" : (keys?.find(k => k.id === v)?.name ?? "Pick a key")}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(keys ?? []).map(k => <SelectItem key={k.id} value={k.id}>{k.name} ({k.provider})</SelectItem>)}
                        <SelectItem value={NEW_KEY}>Add a new key…</SelectItem>
                      </SelectContent>
                    </Select>

                    {llmChoice === "byo" && keyChoice && keyChoice !== NEW_KEY && (byoModels === null || byoModels.length > 0) && (
                      <div className="mt-2">
                        <Label>Model</Label>
                        <Select value={model || "__default__"} onValueChange={v => setModel(v === "__default__" ? "" : (v ?? ""))} disabled={byoModels === null}>
                          <SelectTrigger className="w-full mt-1.5">
                            <SelectValue>{(v: string) => v === "__default__" ? "Default" : v}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__default__">Default</SelectItem>
                            {(byoModels ?? []).map(m => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {byoModels === null ? "Detecting models for this key…" : `Auto-detected from this ${keys?.find(k => k.id === keyChoice)?.provider ?? ""} key.`}
                        </p>
                      </div>
                    )}

                    {keyChoice === NEW_KEY && (
                      <>
                        <div className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr_8rem_1.4fr_auto] gap-2">
                          <Input value={newKeyName} onChange={e => setNewKeyName(e.target.value)} placeholder="Key name" />
                          <Select value={newKeyProvider} onValueChange={v => setNewKeyProvider(v ?? "anthropic")}>
                            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {["anthropic", "openai", "google", "openrouter", "other"].map(pv => <SelectItem key={pv} value={pv}>{pv}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <Input type="password" value={newKeyValue} onChange={e => setNewKeyValue(e.target.value)} placeholder="sk-… or sk-ant-oat…" />
                          <Button variant="outline" size="sm" disabled={keyBusy || !newKeyValue.trim()} onClick={() => void addKeyInline()}>{keyBusy ? "Adding…" : "Add"}</Button>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">An API key — or a Claude subscription token (<code className="font-mono">sk-ant-oat…</code> from <code className="font-mono">claude setup-token</code>); both work in this one field. Sealed at rest in your <Link href="/agents/keys" className="text-primary hover:underline">key vault</Link>.</p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {run === "deployed" && (
              <div className="mt-4">
                <Label>General instructions (agent level)</Label>
                <Textarea
                  value={task}
                  onChange={e => setTask(e.target.value)}
                  placeholder="System prompt / default role instructions for this agent (e.g. 'You are an autonomous UI engineer. Prefer clean code...')"
                  className="mt-1.5 h-20 text-xs"
                />
              </div>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button onClick={submit} disabled={busy || !canSubmit}>{busy ? "Creating…" : "Create agent"}</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
