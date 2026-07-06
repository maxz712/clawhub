"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import {
  api, type Agent, type AgentQuota, type AgentUsageRow, type Risk,
  type AgentVersionRow, type CostEntryRow, type EvalRunRow, type EvalSuiteRow, type QualityScoreRow,
  type AgentRunRow,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CopyBlock } from "@/components/copy-block";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronDown, TriangleAlert, Skull } from "lucide-react";

type AgentRepo = { id: string; name: string; ns: string; changes: number };

// Default earned-autonomy bar (server env may override these, so they're shown
// as "the default bar"). Mirrors services/agent-autonomy.ts:EARNED.
const BAR = { minMergeRate: 80, maxRevertRate: 5, maxDrift: 20, minMergedVolume: 5 };

const TABS = ["overview", "limits", "quality", "versions", "evals", "cost", "governance"] as const;
type TabKey = (typeof TABS)[number];

// One page for everything about a single agent. Merges the old identity/token/
// quota detail with the old /ops console (quality, versions, evals, cost) and a
// new Governance tab (kill switch + the cross-agent incident console) — so an
// agent's whole story lives in one place instead of two near-colliding routes.
export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState<TabKey>("overview");

  // --- identity / token ---
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [quota, setQuota] = useState<AgentQuota | null>(null);
  const [usage, setUsage] = useState<AgentUsageRow[]>([]);
  const [owner, setOwner] = useState<string | null>(null);
  const [repos, setRepos] = useState<AgentRepo[]>([]);

  // --- ops: quality / versions / evals / cost ---
  const [quality, setQuality] = useState<QualityScoreRow | null>(null);
  const [versions, setVersions] = useState<AgentVersionRow[]>([]);
  const [runs, setRuns] = useState<EvalRunRow[]>([]);
  const [suites, setSuites] = useState<EvalSuiteRow[]>([]);
  const [cost, setCost] = useState<{ entries: CostEntryRow[]; monthCents: number } | null>(null);
  const [newVersion, setNewVersion] = useState("");

  // --- governance ---
  const [killed, setKilled] = useState<boolean | null>(null);
  const [govBusy, setGovBusy] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [killReason, setKillReason] = useState("");

  useEffect(() => {
    // Honor a ?tab= deep-link (e.g. the Cost leaderboard links straight to Cost).
    const want = new URLSearchParams(window.location.search).get("tab");
    if (want && (TABS as readonly string[]).includes(want)) setTab(want as TabKey);
  }, []);

  async function loadOps() {
    const [q, v, r, s, c] = await Promise.all([
      api.agentQuality(id).catch(() => null),
      api.listAgentVersions(id).catch(() => ({ versions: [] })),
      api.agentEvalRuns(id).catch(() => ({ runs: [] })),
      api.listEvalSuites().catch(() => ({ suites: [] })),
      api.agentCost(id).catch(() => null),
    ]);
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

  useEffect(() => {
    api.listAgents()
      .then(r => { setAgent(r.agents.find(a => a.id === id) ?? null); setLoaded(true); })
      .catch(e => { setError((e as Error).message); setLoaded(true); });
    api.getQuota(id).then(r => setQuota(r.quota)).catch(() => {});
    api.getAgentUsage(id).then(r => setUsage(r.usage)).catch(() => {});
    api.killSwitchStatus(id).then(r => setKilled(r.engaged)).catch(() => setKilled(null));
    void loadOps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Once we know the agent name, fetch its public profile for the owner handle
  // (the repo namespace) + repo list. Best-effort: the page works without it.
  useEffect(() => {
    if (!agent) return;
    api.publicAgent(agent.name)
      .then(r => { setRepos(r.repos); if (r.repos[0]) setOwner(r.repos[0].ns); })
      .catch(() => {});
  }, [agent]);

  async function rotate() {
    setConfirmRotate(false);
    try { const r = await api.rotateAgentToken(id); setNewToken(r.token); }
    catch (e) { setError((e as Error).message); }
  }
  async function recompute() { const r = await api.recomputeAgentQuality(id); setQuality(r.quality); }

  async function engageKill() {
    setGovBusy(true); setError(null);
    try { await api.engageKillSwitch(id, killReason.trim() || undefined); setKilled(true); setConfirmKill(false); setKillReason(""); }
    catch (e) { setError((e as Error).message); }
    finally { setGovBusy(false); }
  }
  async function releaseKill() {
    setGovBusy(true); setError(null);
    try { await api.releaseKillSwitch(id); setKilled(false); }
    catch (e) { setError((e as Error).message); }
    finally { setGovBusy(false); }
  }

  if (error && !agent) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!loaded) return <div className="text-muted-foreground">Loading…</div>;
  if (!agent) return (
    <div className="max-w-md space-y-3">
      <h1 className="text-2xl font-bold tracking-tight">Agent not found</h1>
      <p className="text-sm text-muted-foreground">This agent doesn&apos;t exist or isn&apos;t one of yours.</p>
      <Link href="/agents"><Button variant="outline" size="sm">Back to agents</Button></Link>
    </div>
  );

  // Build the re-wire command shown after a rotation. Mirror connect-agent-card:
  // preserve the API scheme, embed the new token as the basic-auth password, and
  // point at <owner>/<repo>.git (owner handle when known, else the agent name).
  const soleRepo = repos.length === 1 ? repos[0] : null;
  const ownerHandle = soleRepo?.ns ?? owner ?? agent.name;
  const repoSegment = soleRepo ? soleRepo.name : "<repo>";
  const rewireRemote = newToken
    ? `git remote set-url origin ${api.base.replace(/^(https?):\/\//, "$1://agent-token:" + newToken + "@")}/${ownerHandle}/${repoSegment}.git`
    : null;

  const opened = agent.stats.changesOpened ?? 0;
  const mergedVolume = quality ? Math.round((opened * quality.mergeRate) / 100) : 0;
  const clearsBar = !!quality && opened > 0
    && mergedVolume >= BAR.minMergedVolume
    && quality.mergeRate >= BAR.minMergeRate
    && quality.revertRate <= BAR.maxRevertRate
    && quality.driftScore <= BAR.maxDrift;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/agents" className="text-xs text-muted-foreground hover:text-foreground">← Agents</Link>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">{agent.name}</h1>
          {agent.isPersonal && <Badge variant="outline" className="text-[10px]">personal</Badge>}
          {killed && <Badge variant="destructive" className="gap-1"><Skull className="h-3 w-3" /> killed</Badge>}
        </div>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <Tabs value={tab} onValueChange={v => setTab(v as TabKey)}>
        <TabsList className="w-max">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="limits">Limits</TabsTrigger>
          <TabsTrigger value="quality">Quality</TabsTrigger>
          {/* Power tabs earn their place: hidden until they have content
              (docs/agents-ux.md — a personal agent shouldn't wear 7 tabs). */}
          {versions.length > 0 && <TabsTrigger value="versions">Versions ({versions.length})</TabsTrigger>}
          {runs.length > 0 && <TabsTrigger value="evals">Evals ({runs.length})</TabsTrigger>}
          <TabsTrigger value="cost">Cost</TabsTrigger>
          <TabsTrigger value="governance">Governance</TabsTrigger>
        </TabsList>

        {/* ---- Overview: identity + activity + token + public surface ---- */}
        <TabsContent value="overview" className="space-y-5 pt-4 max-w-2xl">
          <Card>
            <CardHeader><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div><span className="text-muted-foreground">Git author:</span> <code className="font-mono">{agent.gitAuthorName} &lt;{agent.gitAuthorEmail}&gt;</code></div>
              <div><span className="text-muted-foreground">Capabilities:</span> {agent.capabilities.push ? "push" : "—"} {agent.capabilities.review ? "· review" : ""}</div>
              <div><span className="text-muted-foreground">Since:</span> {new Date(agent.createdAt).toLocaleDateString()}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Activity</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="text-sm grid grid-cols-2 gap-4">
                {/* Plain stats — the old "→" linked to the GLOBAL feed, which is
                    not this agent's changes; an honest per-agent list doesn't
                    exist yet, so don't pretend. */}
                <div><div className="text-3xl font-bold text-primary">{agent.stats.changesOpened}</div><div className="text-muted-foreground text-xs">{agent.stats.changesOpened === 1 ? "change opened" : "changes opened"}</div></div>
                <div><div className="text-3xl font-bold text-primary">{agent.stats.reviewsSubmitted}</div><div className="text-muted-foreground text-xs">{agent.stats.reviewsSubmitted === 1 ? "review submitted" : "reviews submitted"}</div></div>
              </div>
              {repos.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Review this agent&apos;s public work</div>
                  {repos.map(r => (
                    <Link
                      key={r.id}
                      href={`/repos/${r.ns}/${r.name}/changes`}
                      className="flex items-center justify-between text-sm rounded-md border border-border px-3 py-1.5 hover:bg-accent transition-colors"
                    >
                      <span className="font-mono">{r.ns}/{r.name}</span>
                      <span className="text-xs text-muted-foreground">{r.changes} change{r.changes === 1 ? "" : "s"} →</span>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* v2: per-agent model intelligence — skills + MCP the harness
              materializes into every run of this agent (any CLI or API loop). */}
          <IntelligenceCard agentId={id} />

          {/* v2: run audit — what each scheduled/triggered/manual run did. */}
          <AgentRunsCard agentId={id} />

          <Card>
            <CardHeader><CardTitle className="text-sm">Token</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {newToken ? (
                <>
                  <CopyBlock label="New token — save now, won't be shown again" value={newToken} />
                  <Alert>
                    <TriangleAlert className="h-4 w-4" />
                    <AlertDescription>
                      The previous token is now <strong>dead</strong>. Re-wire your git remote with the new token, and update any
                      running agent or standing job that authenticated with the old one.
                    </AlertDescription>
                  </Alert>
                  {rewireRemote && (
                    <div className="space-y-1.5">
                      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Re-wire your git remote</div>
                      <CopyBlock value={rewireRemote} />
                      <p className="text-xs text-muted-foreground">
                        Run this inside {soleRepo ? "the repo" : "each repo"} cloned with the old token{rewireRemote.includes("<repo>") ? " (replace the owner/repo placeholders)" : ""}.
                      </p>
                    </div>
                  )}
                </>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => setConfirmRotate(true)}>Rotate token</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Public surface</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>Share URL: <a className="font-mono text-primary hover:underline" href={`/u/${agent.name}`}>/u/{agent.name}</a></div>
              <div>
                Badge:
                <pre className="text-xs bg-muted/40 border border-border p-2 rounded mt-1 overflow-x-auto">
{`![ClawHub agent](${api.agentBadgeUrl(agent.name)})`}
                </pre>
              </div>
              <img src={api.agentOgUrl(agent.name)} alt="Agent preview" className="rounded border border-border w-full" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Limits: quota + usage ---- */}
        <TabsContent value="limits" className="space-y-5 pt-4 max-w-2xl">
          {quota ? <QuotaCard quota={quota} agentId={id} onChange={setQuota} /> : <div className="text-sm text-muted-foreground">No quota configured.</div>}
          <Card>
            <CardHeader><CardTitle className="text-sm">Recent usage</CardTitle></CardHeader>
            <CardContent className="text-xs font-mono space-y-1">
              {usage.length === 0 && <div className="text-muted-foreground">No usage recorded yet.</div>}
              <div className="overflow-x-auto">
                {usage.slice(0, 20).map(u => (
                  <div key={u.id} className="grid grid-cols-[auto_auto_1fr_auto] gap-3">
                    <span className="min-w-0 truncate">{u.window}</span>
                    <span className="min-w-0 truncate text-muted-foreground">{u.kind}</span>
                    <span />
                    <span className="font-bold">{u.count}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Quality + earned autonomy ---- */}
        <TabsContent value="quality" className="space-y-3 pt-4">
          {!quality ? (
            <div className="text-sm text-muted-foreground">No quality score computed yet.</div>
          ) : opened === 0 ? (
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

        {/* ---- Versions ---- */}
        <TabsContent value="versions" className="space-y-2 pt-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Register new version</CardTitle></CardHeader>
            <CardContent className="flex gap-2">
              <Input placeholder="1.2.3" value={newVersion} onChange={e => setNewVersion(e.target.value)} />
              <Button onClick={async () => { if (!newVersion) return; await api.registerAgentVersion(id, { version: newVersion }); setNewVersion(""); void loadOps(); }}>Register</Button>
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
                    <Button key={t} size="sm" variant="outline" disabled={v.trustTier === t} onClick={async () => { await api.promoteAgentTier(id, v.id, t); void loadOps(); }}>{t}</Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        {/* ---- Evals ---- */}
        <TabsContent value="evals" className="space-y-4 pt-4">
          <EvalsTab agentId={id} suites={suites} versions={versions} runs={runs} onChanged={refreshRuns} />
        </TabsContent>

        {/* ---- Cost ---- */}
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

        {/* ---- Governance: kill switch + cross-agent incident console ---- */}
        <TabsContent value="governance" className="space-y-4 pt-4 max-w-2xl">
          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Skull className="h-4 w-4" /> Kill switch</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Status:</span>
                {killed === null ? <Badge variant="outline">unknown</Badge>
                  : killed ? <Badge variant="destructive">KILLED</Badge>
                  : <Badge variant="secondary">live</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                Engaging the kill switch immediately halts this agent — its standing runs are refused and it can&apos;t push.
                Releasing it resumes normal operation. The reason is recorded in the audit trail.
              </p>
              {killed
                ? <Button size="sm" variant="outline" disabled={govBusy} onClick={releaseKill}>Release kill switch</Button>
                : <Button size="sm" variant="destructive" disabled={govBusy} onClick={() => { setKillReason(""); setConfirmKill(true); }}>Engage kill switch</Button>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Blast radius &amp; rollback</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>See what this agent touched in a window and bulk-roll-back its merged changes from the cross-agent incident console.</p>
              <Link href="/agents/ops"><Button size="sm" variant="outline">Open Incident ops →</Button></Link>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={confirmKill} onOpenChange={v => { if (!v && !govBusy) setConfirmKill(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Engage kill switch on “{agent.name}”?</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>Immediately halts this agent — its standing runs are refused and it can&apos;t push — until you release it. Record why; it shows up in the audit trail.</p>
            <div><Label>Reason</Label><Input autoFocus value={killReason} onChange={e => setKillReason(e.target.value)} placeholder="e.g. runaway spend / bad merges" /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={govBusy} onClick={() => setConfirmKill(false)}>Cancel</Button>
            <Button variant="destructive" disabled={govBusy} onClick={engageKill}>{govBusy ? "Engaging…" : "Engage kill switch"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rotate this agent&apos;s token?</DialogTitle></DialogHeader>
          <Alert variant="destructive">
            <TriangleAlert className="h-4 w-4" />
            <AlertDescription>
              This <strong>invalidates the current token immediately</strong>. You must update your git remote and any running
              agent or standing job that uses it, or pushes will start failing with auth errors.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRotate(false)}>Cancel</Button>
            <Button variant="destructive" onClick={rotate}>Rotate token</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function QuotaCard({ quota, agentId, onChange }: { quota: AgentQuota; agentId: string; onChange: (q: AgentQuota) => void }) {
  const [form, setForm] = useState(quota);
  const [busy, setBusy] = useState(false);
  // Quotas/scope are an advanced safety rail — most solo devs never touch them.
  // Collapse by default so the tab stays scannable.
  const [open, setOpen] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const r = await api.updateQuota(agentId, {
        pushPerHour: form.pushPerHour,
        reviewPerHour: form.reviewPerHour,
        apiPerHour: form.apiPerHour,
        maxLocPerChange: form.maxLocPerChange,
        pathAllowlist: form.pathAllowlist,
        pathDenylist: form.pathDenylist,
        riskCeiling: form.riskCeiling,
      });
      onChange(r.quota);
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader className="pb-0">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex w-full items-center justify-between text-left"
        >
          <CardTitle className="text-sm">Quotas &amp; scope <span className="font-normal text-muted-foreground">· advanced</span></CardTitle>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        <p className="text-xs text-muted-foreground pt-1">Per-agent rate + path limits. Empty allowlist = all paths; 0 = unlimited.</p>
      </CardHeader>
      {!open ? null : (
      <CardContent className="space-y-3 text-sm pt-4">
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Push / hr</Label><Input type="number" value={form.pushPerHour} onChange={e => setForm({ ...form, pushPerHour: Number(e.target.value) })} /></div>
          <div><Label>Review / hr</Label><Input type="number" value={form.reviewPerHour} onChange={e => setForm({ ...form, reviewPerHour: Number(e.target.value) })} /></div>
          <div><Label>API / hr</Label><Input type="number" value={form.apiPerHour} onChange={e => setForm({ ...form, apiPerHour: Number(e.target.value) })} /></div>
          <div><Label>Max LOC / change</Label><Input type="number" value={form.maxLocPerChange} onChange={e => setForm({ ...form, maxLocPerChange: Number(e.target.value) })} /></div>
        </div>
        <div>
          <Label>Risk ceiling</Label>
          <Select value={form.riskCeiling} onValueChange={v => setForm({ ...form, riskCeiling: (v ?? "critical") as Risk })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["low", "medium", "high", "critical"] as Risk[]).map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Path allowlist (one glob per line, empty = all)</Label>
          <textarea
            className="w-full font-mono text-xs border border-border rounded p-2 bg-background"
            rows={3}
            value={form.pathAllowlist.join("\n")}
            onChange={e => setForm({ ...form, pathAllowlist: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })}
          />
        </div>
        <div>
          <Label>Path denylist</Label>
          <textarea
            className="w-full font-mono text-xs border border-border rounded p-2 bg-background"
            rows={3}
            value={form.pathDenylist.join("\n")}
            onChange={e => setForm({ ...form, pathDenylist: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })}
          />
        </div>
        <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      </CardContent>
      )}
    </Card>
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
  const suiteById = new Map(suites.map(s => [s.id, s] as const));

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


// ---- v2 agents-ux cards ----------------------------------------------------

function IntelligenceCard({ agentId }: { agentId: string }) {
  const [skills, setSkills] = useState<Array<{ name: string; content: string }>>([]);
  const [mcp, setMcp] = useState<Array<{ name: string; command?: string; url?: string }>>([]);
  const [skName, setSkName] = useState(""); const [skContent, setSkContent] = useState("");
  const [mcpName, setMcpName] = useState(""); const [mcpTarget, setMcpTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.getAgentIntelligence(agentId).then(r => {
      setSkills(r.intelligence?.skills ?? []);
      setMcp((r.intelligence?.mcpServers ?? []).map(m => ({ name: m.name, command: [m.command, ...(m.args ?? [])].filter(Boolean).join(" "), url: m.url })));
    }).catch(() => {});
  }, [agentId]);

  async function save(nextSkills: typeof skills, nextMcp: typeof mcp) {
    setSaving(true); setMsg(null);
    try {
      const r = await api.patchAgentIntelligence(agentId, {
        skills: nextSkills,
        mcpServers: nextMcp.map(m => m.url ? { name: m.name, url: m.url } : { name: m.name, command: (m.command ?? "").split(/\s+/)[0], args: (m.command ?? "").split(/\s+/).slice(1) }),
      });
      setSkills(r.intelligence?.skills ?? []);
      setMcp((r.intelligence?.mcpServers ?? []).map(m => ({ name: m.name, command: [m.command, ...(m.args ?? [])].filter(Boolean).join(" "), url: m.url })));
      setMsg("Saved — applies to this agent's next run.");
    } catch (e) { setMsg((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Intelligence</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Skills and MCP servers injected into every run of this agent — the harness materializes them for whichever CLI or API loop runs it (skills land in <code className="font-mono">.claude/skills/</code>, MCP in <code className="font-mono">.mcp.json</code>, and both are surfaced in the prompt).
        </p>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        {skills.map((sk, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5">
            <span className="font-mono text-xs">{sk.name}</span>
            <span className="text-xs text-muted-foreground truncate flex-1">{sk.content.slice(0, 80)}</span>
            <button type="button" className="cursor-pointer text-xs text-destructive hover:underline" onClick={() => void save(skills.filter((_, j) => j !== i), mcp)}>remove</button>
          </div>
        ))}
        <div className="grid grid-cols-1 gap-2">
          <div className="flex gap-2">
            <Input value={skName} onChange={e => setSkName(e.target.value)} placeholder="skill-name" className="w-44" />
            <Input value={skContent} onChange={e => setSkContent(e.target.value)} placeholder="Skill instructions (markdown)" className="flex-1" />
            <Button size="sm" variant="outline" disabled={saving || !skName.trim() || !skContent.trim()}
              onClick={() => { void save([...skills, { name: skName.trim(), content: skContent }], mcp); setSkName(""); setSkContent(""); }}>Add skill</Button>
          </div>
          {mcp.map((m, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5">
              <span className="font-mono text-xs">{m.name}</span>
              <span className="text-xs text-muted-foreground truncate flex-1">{m.url ?? m.command}</span>
              <button type="button" className="cursor-pointer text-xs text-destructive hover:underline" onClick={() => void save(skills, mcp.filter((_, j) => j !== i))}>remove</button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input value={mcpName} onChange={e => setMcpName(e.target.value)} placeholder="mcp-server" className="w-44" />
            <Input value={mcpTarget} onChange={e => setMcpTarget(e.target.value)} placeholder="command … or https:// URL" className="flex-1 font-mono text-xs" />
            <Button size="sm" variant="outline" disabled={saving || !mcpName.trim() || !mcpTarget.trim()}
              onClick={() => { const t = mcpTarget.trim(); void save(skills, [...mcp, t.startsWith("http") ? { name: mcpName.trim(), url: t } : { name: mcpName.trim(), command: t }]); setMcpName(""); setMcpTarget(""); }}>Add MCP</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AgentRunsCard({ agentId }: { agentId: string }) {
  const [runs, setRuns] = useState<AgentRunRow[] | null>(null);
  useEffect(() => {
    api.getAgentRuns(agentId).then(r => setRuns(r.runs)).catch(() => setRuns([]));
  }, [agentId]);
  if (!runs || runs.length === 0) return null;
  const STATUS_COLOR: Record<string, string> = {
    success: "text-primary", failure: "text-destructive", running: "text-blue-400",
    pending: "text-muted-foreground", skipped: "text-muted-foreground",
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Runs</CardTitle></CardHeader>
      <CardContent className="space-y-1.5">
        <p className="text-xs text-muted-foreground">Every scheduled, triggered, and manual run of this agent, newest first — the audit trail of what it did.</p>
        {runs.slice(0, 15).map(r => (
          <div key={r.id} className="flex items-center gap-2 text-xs rounded-md border border-border/60 px-2.5 py-1.5">
            <span className={`font-medium uppercase ${STATUS_COLOR[r.status] ?? "text-muted-foreground"}`}>{r.status}</span>
            <span className="font-mono truncate">{r.repoNs ? `${r.repoNs}/` : ""}{r.repoName}</span>
            {r.dispatchTask && <span className="text-muted-foreground truncate flex-1">{r.dispatchTask.slice(0, 60)}</span>}
            <span className="ml-auto text-muted-foreground shrink-0">{new Date(r.createdAt).toLocaleString()}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
