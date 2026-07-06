"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type AccessRoleRow, type LlmKeyRow, type Repo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CopyBlock } from "@/components/copy-block";

// v2 agents-ux (docs/agents-ux.md): creating an agent is name + role + key,
// with instruction PRESETS so a full autonomous loop is one dropdown choice —
// one agent whose instructions cover scout + build + review, not three
// deployments. No container knobs anywhere.
const PRESETS: Record<string, { label: string; mode: string; cadence: "daily" | "hourly" | "continuous" | "on_change"; instructions: string }> = {
  full_loop: {
    label: "Full loop — scout, build, verify, review",
    mode: "develop",
    cadence: "daily",
    instructions:
      "You own this repo's improvement loop. Each run: " +
      "1) If there are no open issues, scan the repo and file ONE well-scoped, high-value issue. " +
      "2) Pick the most valuable open issue (assigned to you or unassigned), implement it end-to-end with tests. " +
      "3) Run the app and verify your work behaves — click through the changed surface in the browser. " +
      "4) Open ONE Change with clear trailers and screenshot evidence. " +
      "5) Review any open Changes you did not author and submit an honest verdict.",
  },
  reviewer: {
    label: "Reviewer — verify every new Change",
    mode: "verify",
    cadence: "on_change",
    instructions:
      "Review the Change you were dispatched for. Read the diff with its focus flags, boot the app, exercise the changed " +
      "surface end-to-end in the browser, attach screenshot evidence, and submit a verdict with your findings. Be specific and honest.",
  },
  scout: {
    label: "Scout — file one good issue per run",
    mode: "worker",
    cadence: "daily",
    instructions:
      "Scan the repo — code, docs, tests, TODOs, recent Changes — and file exactly ONE well-scoped, high-value issue via the " +
      "ClawHub API. Include repro/context and acceptance criteria. Do not push code.",
  },
  custom: { label: "Custom instructions", mode: "develop", cadence: "daily", instructions: "" },
};

const PLATFORM_KEY = "__platform__";
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
  const [keyChoice, setKeyChoice] = useState<string>(PLATFORM_KEY);
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("full_loop");
  const [instructions, setInstructions] = useState(PRESETS.full_loop.instructions);
  const [cadence, setCadence] = useState<"daily" | "hourly" | "continuous" | "on_change">("daily");

  // Inline "add key" mini-form.
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyProvider, setNewKeyProvider] = useState("anthropic");
  const [newKeyValue, setNewKeyValue] = useState("");
  // Inline "new role" mini-form.
  const [newRoleName, setNewRoleName] = useState("");
  const [newRolePush, setNewRolePush] = useState(true);
  const [newRoleReview, setNewRoleReview] = useState(true);
  const [newRoleScope, setNewRoleScope] = useState<"all" | "selected">("all");
  const [newRoleRepoIds, setNewRoleRepoIds] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api.listAccessRoles().then(r => {
      setRoles(r.roles);
      // Preselect the Developer default so the happy path is two fields.
      if (!roleId && r.roles.length) setRoleId((r.roles.find(x => x.name === "Developer") ?? r.roles[0]).id);
    }).catch(e => setError((e as Error).message));
    api.listLlmKeys().then(r => setKeys(r.keys)).catch(() => setKeys([]));
    api.listRepos().then(r => setRepos(r.repos)).catch(() => setRepos([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedRole = useMemo(() => roles?.find(r => r.id === roleId) ?? null, [roles, roleId]);
  const scopedRepos = useMemo(() => {
    if (!repos) return [];
    if (!selectedRole || selectedRole.repoScope === "all") return repos;
    return repos.filter(r => selectedRole.repoIds.includes(r.id));
  }, [repos, selectedRole]);

  function applyPreset(k: keyof typeof PRESETS) {
    setPreset(k);
    if (k !== "custom") { setInstructions(PRESETS[k].instructions); setCadence(PRESETS[k].cadence); }
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      let effectiveRoleId = roleId;
      if (roleId === NEW_ROLE) {
        const created = await api.createAccessRole({
          name: newRoleName.trim() || "Custom role",
          permissions: { push: newRolePush, review: newRoleReview },
          repoScope: newRoleScope, repoIds: newRoleScope === "selected" ? newRoleRepoIds : [],
        });
        effectiveRoleId = created.role.id;
      }
      let llmKeyId: string | undefined;
      let keySource: "platform" | undefined;
      if (run === "deployed") {
        if (keyChoice === PLATFORM_KEY) keySource = "platform";
        else if (keyChoice === NEW_KEY) {
          const created = await api.createLlmKey({ name: newKeyName.trim() || "My key", provider: newKeyProvider, key: newKeyValue.trim() });
          llmKeyId = created.key.id;
        } else llmKeyId = keyChoice;
      }
      const res = await api.createManagedAgent({
        name: name.trim(), accessRoleId: effectiveRoleId, run,
        llmKeyId, keySource,
        repoIds: run === "deployed" ? repoIds : undefined,
        instructions: run === "deployed" ? instructions : undefined,
        cadence: run === "deployed" ? cadence : undefined,
        mode: run === "deployed" ? PRESETS[preset].mode : undefined,
      });
      setCreatedName(res.agent.name);
      if (res.token) setCreatedToken(res.token);
      onCreated();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function reset() {
    setCreatedToken(null); setCreatedName(null); setName(""); setError(null);
    setRun("local"); setRepoIds([]); applyPreset("full_loop");
  }

  const canSubmit = Boolean(
    name.trim() &&
    (roleId && (roleId !== NEW_ROLE || newRoleName.trim())) &&
    (run === "local" || (repoIds.length > 0 && (keyChoice !== NEW_KEY || newKeyValue.trim()))),
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
            ) : (
              <p className="text-sm text-muted-foreground">
                Deployed. ClawHub holds its credentials — nothing to paste. It runs on its cadence; use Run now on the agent card to kick a first run.
              </p>
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
                  <div className="flex gap-4 text-sm">
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" className="accent-primary" checked={newRolePush} onChange={e => setNewRolePush(e.target.checked)} /> Push code</label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" className="accent-primary" checked={newRoleReview} onChange={e => setNewRoleReview(e.target.checked)} /> Review Changes</label>
                  </div>
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
              <>
                <div>
                  <Label>LLM</Label>
                  <Select value={keyChoice} onValueChange={v => setKeyChoice(v ?? PLATFORM_KEY)}>
                    <SelectTrigger className="w-full mt-1.5">
                      <SelectValue>{(v: string) => v === PLATFORM_KEY ? "Platform LLM (metered)" : v === NEW_KEY ? "Add a key…" : (keys?.find(k => k.id === v)?.name ?? "Pick")}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={PLATFORM_KEY}>Platform LLM (metered — no key to paste)</SelectItem>
                      {(keys ?? []).map(k => <SelectItem key={k.id} value={k.id}>{k.name} ({k.provider})</SelectItem>)}
                      <SelectItem value={NEW_KEY}>Add a key…</SelectItem>
                    </SelectContent>
                  </Select>
                  {keyChoice === NEW_KEY && (
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <Input value={newKeyName} onChange={e => setNewKeyName(e.target.value)} placeholder="Key name" />
                      <Select value={newKeyProvider} onValueChange={v => setNewKeyProvider(v ?? "anthropic")}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {["anthropic", "openai", "google", "openrouter"].map(pv => <SelectItem key={pv} value={pv}>{pv}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input type="password" value={newKeyValue} onChange={e => setNewKeyValue(e.target.value)} placeholder="sk-…" />
                    </div>
                  )}
                </div>

                <div>
                  <Label>Repos it works in</Label>
                  <div className="mt-1.5 max-h-36 overflow-y-auto space-y-1 rounded-md border border-border/60 p-2">
                    {scopedRepos.length === 0 && <p className="text-xs text-muted-foreground">No repos in this role&apos;s scope.</p>}
                    {scopedRepos.map(r => (
                      <label key={r.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox" className="accent-primary" checked={repoIds.includes(r.id)}
                          onChange={e => setRepoIds(ids => e.target.checked ? [...ids, r.id] : ids.filter(x => x !== r.id))} />
                        <span className="font-mono text-xs">{r.namespaceName}/{r.name}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <Label>Instructions</Label>
                  <Select value={preset} onValueChange={v => applyPreset((v ?? "full_loop") as keyof typeof PRESETS)}>
                    <SelectTrigger className="w-full mt-1.5"><SelectValue>{(v: string) => PRESETS[v as keyof typeof PRESETS]?.label ?? v}</SelectValue></SelectTrigger>
                    <SelectContent>
                      {Object.entries(PRESETS).map(([k, p]) => <SelectItem key={k} value={k}>{p.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Textarea className="mt-2 font-mono text-xs" rows={5} value={instructions} onChange={e => { setInstructions(e.target.value); setPreset("custom"); }} placeholder="What should this agent do each run?" />
                </div>

                <div>
                  <Label>Cadence</Label>
                  <Select value={cadence} onValueChange={v => setCadence((v ?? "daily") as typeof cadence)}>
                    <SelectTrigger className="w-full mt-1.5">
                      <SelectValue>{(v: string) => ({ daily: "Daily", hourly: "Hourly", continuous: "Continuously", on_change: "On every new Change" }[v] ?? v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="continuous">Continuously</SelectItem>
                      <SelectItem value="on_change">On every new Change</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
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
