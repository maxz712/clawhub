"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, type Agent, type AgentVersionRow, type CostEntryRow, type EvalRunRow, type EvalSuiteRow, type QualityScoreRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Default earned-autonomy bar (server env may override these, so they're shown
// as "the default bar"). Mirrors services/agent-autonomy.ts:EARNED.
const BAR = { minMergeRate: 80, maxRevertRate: 5, maxDrift: 20, minMergedVolume: 5 };

export default function AgentOpsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [quality, setQuality] = useState<QualityScoreRow | null>(null);
  const [versions, setVersions] = useState<AgentVersionRow[]>([]);
  const [runs, setRuns] = useState<EvalRunRow[]>([]);
  const [suites, setSuites] = useState<EvalSuiteRow[]>([]);
  const [cost, setCost] = useState<{ entries: CostEntryRow[]; monthCents: number } | null>(null);
  const [newVersion, setNewVersion] = useState("");

  const agentName = agent?.name ?? null;

  async function load() {
    const [agents, q, v, r, s, c] = await Promise.all([
      api.listAgents().catch(() => ({ agents: [] })),
      api.agentQuality(id).catch(() => null),
      api.listAgentVersions(id).catch(() => ({ versions: [] })),
      api.agentEvalRuns(id).catch(() => ({ runs: [] })),
      api.listEvalSuites().catch(() => ({ suites: [] })),
      api.agentCost(id).catch(() => null),
    ]);
    setAgent(agents.agents.find(a => a.id === id) ?? null);
    if (q) setQuality(q.quality);
    setVersions(v.versions);
    setRuns(r.runs);
    setSuites(s.suites);
    if (c) setCost(c);
  }

  async function refreshRuns() {
    const [r, s] = await Promise.all([
      api.agentEvalRuns(id).catch(() => ({ runs: [] })),
      api.listEvalSuites().catch(() => ({ suites: [] })),
    ]);
    setRuns(r.runs);
    setSuites(s.suites);
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function recompute() { const r = await api.recomputeAgentQuality(id); setQuality(r.quality); }

  // Track-record figures for the quality / earned-autonomy panel. `changesOpened`
  // comes from the agent stats; merged volume is derived from the merge rate (the
  // quality row carries rates, not raw counts).
  const opened = agent?.stats.changesOpened ?? 0;
  const mergedVolume = quality ? Math.round((opened * quality.mergeRate) / 100) : 0;
  const clearsBar = !!quality && opened > 0
    && mergedVolume >= BAR.minMergedVolume
    && quality.mergeRate >= BAR.minMergeRate
    && quality.revertRate <= BAR.maxRevertRate
    && quality.driftScore <= BAR.maxDrift;

  return (
    <div className="space-y-4">
      <div>
        <Link href={`/agents/${id}`} className="text-xs text-muted-foreground hover:text-foreground">← Agent detail</Link>
        <h1 className="text-2xl font-bold tracking-tight">Agent ops · {agentName ? `@${agentName}` : id.slice(0, 8)}</h1>
      </div>

      <Tabs defaultValue="quality">
        <TabsList>
          <TabsTrigger value="quality">Quality</TabsTrigger>
          <TabsTrigger value="versions">Versions ({versions.length})</TabsTrigger>
          <TabsTrigger value="evals">Evals ({runs.length})</TabsTrigger>
          <TabsTrigger value="cost">Cost</TabsTrigger>
        </TabsList>

        <TabsContent value="quality" className="space-y-3 pt-4">
          {!quality ? (
            <div className="text-sm text-muted-foreground">No quality score computed yet.</div>
          ) : opened === 0 ? (
            // 0% across the board is meaningless with no track record — say so.
            <div className="rounded border bg-card p-4 text-sm text-muted-foreground">
              No history yet (0 changes). Quality metrics appear once this agent has opened changes.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <Stat label="Merge rate" value={`${quality.mergeRate}%`} accent="var(--primary)"
                  pass={quality.mergeRate >= BAR.minMergeRate} threshold={`≥ ${BAR.minMergeRate}%`} />
                <Stat label="Revert rate" value={`${quality.revertRate}%`} accent="var(--destructive)"
                  pass={quality.revertRate <= BAR.maxRevertRate} threshold={`≤ ${BAR.maxRevertRate}%`} />
                <Stat label="TTG CI p50" value={`${Math.round(quality.timeToGreenCiP50 / 60)}m`} />
                <Stat label="Review hit" value={`${quality.reviewHitRate}%`} />
                <Stat label="Drift" value={`${quality.driftScore}`}
                  pass={quality.driftScore <= BAR.maxDrift} threshold={`≤ ${BAR.maxDrift}`} />
              </div>

              {/* Earned autonomy legibility — whether this agent's record clears
                  the default quality bar, plus what else autonomy requires. */}
              <div className="rounded border bg-card p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Earned autonomy</span>
                  <Badge variant={clearsBar ? "default" : "secondary"}
                    className={clearsBar ? "bg-primary/15 text-primary border border-primary/30" : ""}>
                    {clearsBar ? "QUALITY BAR: PASS" : "QUALITY BAR: FAIL"}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  Track record: ~{mergedVolume} merged of {opened} opened
                  (bar needs ≥ {BAR.minMergedVolume} merged).
                  {!clearsBar && " Below the bar — this agent cannot self-merge yet."}
                </div>
                <p className="text-xs text-muted-foreground">
                  Earned autonomy is <strong>LOW-risk only</strong> and never bypasses sensitive-path,
                  medium+, or human-approval gates — a human still owns every merge above low risk.
                  Activation also requires the agent to be opted-in on a role and at a sufficient trust
                  tier (governed per-org), so a passing bar here is necessary but not sufficient.
                </p>
              </div>
            </>
          )}
          <Button size="sm" onClick={recompute}>Recompute now</Button>
        </TabsContent>

        <TabsContent value="versions" className="space-y-2 pt-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Register new version</CardTitle></CardHeader>
            <CardContent className="flex gap-2">
              <Input placeholder="1.2.3" value={newVersion} onChange={e => setNewVersion(e.target.value)} />
              <Button onClick={async () => { if (!newVersion) return; await api.registerAgentVersion(id, { version: newVersion }); setNewVersion(""); void load(); }}>Register</Button>
            </CardContent>
          </Card>
          {versions.length > 0 && (
            <p className="text-xs text-muted-foreground px-1">
              The <strong>latest</strong> version&rsquo;s trust tier is a floor on earned autonomy: at{" "}
              <span className="font-mono">standard</span>+ it can self-merge its own low-risk work; below that a
              human owns every merge. A passing eval auto-promotes only up to <span className="font-mono">sandbox</span>{" "}
              — reaching <span className="font-mono">standard</span>/<span className="font-mono">trusted</span> requires a
              human to grant it here. (Sensitive-path, medium+, and human-approval gates always apply.)
            </p>
          )}
          {versions.map((v, idx) => (
            <Card key={v.id}>
              <CardContent className="pt-4 flex items-center justify-between">
                <div>
                  <div className="font-mono font-semibold flex items-center gap-2">
                    v{v.version}
                    {idx === 0 && <Badge variant="outline" className="text-[10px]">latest</Badge>}
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">{v.modelName ?? "(no model)"} · {v.promptHash ?? ""}</div>
                </div>
                <div className="flex gap-2 items-center">
                  <Badge variant={v.trustTier === "trusted" ? "default" : v.trustTier === "standard" ? "secondary" : "outline"}>{v.trustTier}</Badge>
                  {(["untrusted", "sandbox", "standard", "trusted"] as const).map(t => (
                    <Button key={t} size="sm" variant="outline" disabled={v.trustTier === t} onClick={async () => { await api.promoteAgentTier(id, v.id, t); void load(); }}>{t}</Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="evals" className="space-y-4 pt-4">
          <EvalsTab agentId={id} suites={suites} versions={versions} runs={runs} onChanged={refreshRuns} />
        </TabsContent>

        <TabsContent value="cost" className="space-y-3 pt-4">
          {cost && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Stat label="This month" value={`$${(cost.monthCents / 100).toFixed(2)}`} accent="var(--primary)" />
              <Stat label="Entries" value={String(cost.entries.length)} />
              <Stat label="Avg / entry" value={`$${((cost.monthCents / 100) / Math.max(cost.entries.length, 1)).toFixed(2)}`} />
            </div>
          )}
          <div className="font-mono text-xs space-y-1">
            {cost?.entries.slice(0, 20).map(e => (
              <div key={e.id} className="grid grid-cols-[auto_1fr_auto_auto] gap-3 py-1 border-b border-border">
                <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleDateString()}</span>
                <span className="truncate">{e.model ?? e.kind}</span>
                <span>{(e.inputTokens + e.outputTokens).toLocaleString()} tok</span>
                <span className="font-bold">${(e.costCents / 100).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value, accent, pass, threshold }: { label: string; value: string; accent?: string; pass?: boolean; threshold?: string }) {
  return (
    <div className="rounded border bg-card p-3">
      <div className="text-xs font-mono text-muted-foreground uppercase">{label}</div>
      <div className="text-2xl font-bold mt-1" style={{ color: accent ?? "inherit" }}>{value}</div>
      {threshold !== undefined && pass !== undefined && (
        <div className={`text-[10px] font-mono mt-1 ${pass ? "text-primary" : "text-destructive"}`}>
          {pass ? "✓" : "✗"} {threshold}
        </div>
      )}
    </div>
  );
}

const VERSION_LATEST = "__latest";

function EvalsTab({ agentId, suites, versions, runs, onChanged }: {
  agentId: string;
  suites: EvalSuiteRow[];
  versions: AgentVersionRow[];
  runs: EvalRunRow[];
  onChanged: () => void | Promise<void>;
}) {
  // Suites are keyed by id for resolving a run's threshold (so we can green a
  // score that clears its suite's bar even when the run row omits the suite).
  const suiteById = new Map(suites.map(s => [s.id, s] as const));

  // --- Create suite dialog state ---
  const [suiteOpen, setSuiteOpen] = useState(false);
  const [sName, setSName] = useState("");
  const [sDesc, setSDesc] = useState("");
  const [sThreshold, setSThreshold] = useState("80");
  const [sCases, setSCases] = useState("[]");
  const [sError, setSError] = useState<string | null>(null);
  const [sBusy, setSBusy] = useState(false);

  async function createSuite() {
    if (!sName.trim()) { setSError("Name is required."); return; }
    let cases: unknown[];
    try {
      const parsed = JSON.parse(sCases || "[]");
      if (!Array.isArray(parsed)) { setSError("Cases must be a JSON array."); return; }
      cases = parsed;
    } catch {
      setSError("Cases is not valid JSON.");
      return;
    }
    const threshold = Number(sThreshold);
    if (!Number.isFinite(threshold)) { setSError("Passing threshold must be a number."); return; }
    setSError(null);
    setSBusy(true);
    try {
      await api.createEvalSuite({
        name: sName.trim(),
        description: sDesc.trim() || undefined,
        cases,
        passingThreshold: threshold,
      });
      setSName(""); setSDesc(""); setSThreshold("80"); setSCases("[]");
      setSuiteOpen(false);
      await onChanged();
    } catch (e) {
      setSError(e instanceof Error ? e.message : "Failed to create suite.");
    } finally {
      setSBusy(false);
    }
  }

  // --- Run eval dialog state ---
  const [runOpen, setRunOpen] = useState(false);
  const [rSuiteId, setRSuiteId] = useState("");
  const [rVersionId, setRVersionId] = useState(VERSION_LATEST);
  const [rError, setRError] = useState<string | null>(null);
  const [rBusy, setRBusy] = useState(false);

  async function queueRun() {
    if (!rSuiteId) { setRError("Pick a suite."); return; }
    setRError(null);
    setRBusy(true);
    try {
      await api.queueEvalRun({
        suiteId: rSuiteId,
        agentId,
        agentVersionId: rVersionId === VERSION_LATEST ? undefined : rVersionId,
      });
      setRunOpen(false);
      await onChanged();
    } catch (e) {
      setRError(e instanceof Error ? e.message : "Failed to queue run.");
    } finally {
      setRBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Author eval suites and queue runs against this agent. Eval results are self-reported, so a passing run
        auto-promotes a version only up to <span className="font-mono">sandbox</span>; the{" "}
        <span className="font-mono">standard</span>+ tiers that unlock self-merge require a human in{" "}
        <span className="font-mono">Versions</span>.
      </p>

      {/* --- Suites sub-section --- */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Suites ({suites.length})</CardTitle>
          <Button size="sm" onClick={() => { setSError(null); setSuiteOpen(true); }}>Create suite</Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {suites.length === 0 && <div className="text-sm text-muted-foreground">No eval suites yet.</div>}
          {suites.map(s => (
            <div key={s.id} className="flex items-center justify-between rounded border bg-background/40 px-3 py-2">
              <div>
                <div className="text-sm font-medium">{s.name}</div>
                {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
              </div>
              <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                <span>{s.cases.length} case{s.cases.length === 1 ? "" : "s"}</span>
                <Badge variant="outline">pass ≥ {s.passingThreshold}</Badge>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={suiteOpen} onOpenChange={setSuiteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Create eval suite</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="eval-suite-name">Name</Label>
              <Input id="eval-suite-name" placeholder="regression-smoke" value={sName} onChange={e => setSName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="eval-suite-desc">Description</Label>
              <Input id="eval-suite-desc" placeholder="Optional" value={sDesc} onChange={e => setSDesc(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="eval-suite-threshold">Passing threshold</Label>
              <Input id="eval-suite-threshold" type="number" value={sThreshold} onChange={e => setSThreshold(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="eval-suite-cases">Cases (JSON array)</Label>
              <Textarea id="eval-suite-cases" className="font-mono text-xs min-h-32" value={sCases} onChange={e => setSCases(e.target.value)} />
            </div>
            {sError && <div className="text-xs text-destructive">{sError}</div>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSuiteOpen(false)}>Cancel</Button>
            <Button onClick={createSuite} disabled={sBusy}>{sBusy ? "Creating…" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Runs sub-section --- */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Runs ({runs.length})</CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void onChanged()}>Refresh</Button>
            <Button size="sm" onClick={() => { setRError(null); setRSuiteId(suites[0]?.id ?? ""); setRVersionId(VERSION_LATEST); setRunOpen(true); }} disabled={suites.length === 0}>Run eval</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {runs.length === 0 && <div className="text-sm text-muted-foreground">No eval runs yet.</div>}
          {runs.map(r => {
            const threshold: number | null = r.suiteId ? (suiteById.get(r.suiteId)?.passingThreshold ?? null) : null;
            const passed = r.score != null && threshold != null && r.score >= threshold;
            return (
              <Card key={r.id}>
                <CardContent className="pt-4 flex flex-col gap-1">
                  <div className="flex items-center gap-3">
                    <Badge variant={r.status === "finished" ? "default" : r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge>
                    {(r.suiteName ?? (r.suiteId ? suiteById.get(r.suiteId)?.name : null)) && (
                      <span className="text-sm font-medium">{r.suiteName ?? suiteById.get(r.suiteId)?.name}</span>
                    )}
                    <span className={`font-mono text-sm ${r.score == null ? "" : passed ? "text-primary" : "text-destructive"}`}>
                      score: {r.score ?? "—"}{threshold != null && <span className="text-muted-foreground"> / {threshold}</span>}
                    </span>
                    <span className="text-xs font-mono text-muted-foreground ml-auto">{new Date(r.createdAt).toLocaleString()}</span>
                  </div>
                  {r.promotedTo && (
                    <div className="text-xs">
                      <Badge variant="default" className="bg-primary/15 text-primary border border-primary/30 font-mono">
                        auto-promoted {r.promotedFrom} → {r.promotedTo}
                      </Badge>
                      <span className="text-muted-foreground ml-2">
                        {r.versionLabel ? `v${r.versionLabel} ` : ""}via eval{r.suiteName ? ` ${r.suiteName}` : ""}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </CardContent>
      </Card>

      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Run eval</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Suite</Label>
              <Select value={rSuiteId} onValueChange={v => setRSuiteId(v ?? "")}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Pick a suite" /></SelectTrigger>
                <SelectContent>
                  {suites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Version</Label>
              <Select value={rVersionId} onValueChange={v => setRVersionId(v ?? VERSION_LATEST)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={VERSION_LATEST}>latest</SelectItem>
                  {versions.map(v => <SelectItem key={v.id} value={v.id}>v{v.version} · {v.trustTier}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {rError && <div className="text-xs text-destructive">{rError}</div>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRunOpen(false)}>Cancel</Button>
            <Button onClick={queueRun} disabled={rBusy || !rSuiteId}>{rBusy ? "Queuing…" : "Queue run"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
