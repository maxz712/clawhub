"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type OrgRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getAgentToken, setAgentToken, getStoredUser } from "@/lib/auth";

type Provider = "github" | "gitlab" | "bitbucket";

// "Your account" — import under the logged-in human's own handle (resolved to
// the real username at submit). The default: consistent with `ch init`, where a
// human's pushed repo lands under @handle, not the agent's namespace.
const SELF_NS = "__self__";
// The calling agent's own service-user namespace (the historical default).
const DEFAULT_NS = "__default__";
// Persists the in-flight import job id so a tab close mid-import isn't lossy.
const IMPORT_JOB_KEY = "clawhub_import_job";

export default function ImportPage() {
  const [provider, setProvider] = useState<Provider>("github");

  // GitHub fields.
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  // GitLab fields.
  const [glToken, setGlToken] = useState("");
  const [glProject, setGlProject] = useState("");
  const [glHost, setGlHost] = useState("");
  // Bitbucket fields.
  const [bbUser, setBbUser] = useState("");
  const [bbPass, setBbPass] = useState("");
  const [bbWorkspace, setBbWorkspace] = useState("");
  const [bbSlug, setBbSlug] = useState("");

  const [targetName, setTargetName] = useState("");
  const [targetNs, setTargetNs] = useState<string>(SELF_NS);
  const [myHandle, setMyHandle] = useState<string | null>(() => getStoredUser()?.username ?? null);
  const [adminOrgs, setAdminOrgs] = useState<OrgRow[]>([]);
  const [agentToken, setAgentTok] = useState(() => getAgentToken() ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState<{ namespace: string; repoName: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetchingAgent, setFetchingAgent] = useState(false);

  // Target-namespace options: the user's own handle (default) + the agent's own
  // namespace + the orgs the caller ADMINS — the only org namespaces the backend
  // will let the agent create a repo in (mirrors the org-admin create gate).
  useEffect(() => {
    api.listOrgs()
      .then(r => setAdminOrgs(r.orgs.filter(o => o.role === "admin")))
      .catch(() => { /* not logged in / no orgs — default namespace still works */ });
    // Resolve the caller's handle for the "your account" default even if the
    // stored session predates usernames (/me mints one on demand).
    if (!myHandle) api.getMe().then(u => { if (u.username) setMyHandle(u.username); }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The once-shown agent token isn't retrievable, so a logged-in human with no
  // saved token would dead-end. Mint/return their personal agent token in one
  // click (find-or-create; the repo lands in that agent's namespace by default).
  async function useMyAgent() {
    setErr(null); setFetchingAgent(true);
    try {
      const r = await api.personalAgent();
      if (r.token) { setAgentTok(r.token); setAgentToken(r.token, "import-agent"); }
      else setErr("Your personal agent already exists but its token isn't retrievable — rotate it on the Agents page and paste it here.");
    } catch (e) { setErr((e as Error).message); }
    finally { setFetchingAgent(false); }
  }

  // Poll a background import job to completion and render the result. The jobId
  // is persisted (see run() + the resume effect), so closing the tab mid-import
  // isn't lossy — reopening /import resumes polling the same job.
  async function pollJob(jobId: string) {
    setBusy(true);
    try {
      let job = await api.getImportJob(jobId);
      for (let i = 0; i < 600 && (job.status === "pending" || job.status === "running"); i++) {
        await new Promise(res => setTimeout(res, 1500));
        job = await api.getImportJob(jobId);
      }
      if (job.status !== "success" || !job.result) throw new Error(job.errorMessage || "import did not complete in time — check the repo list");
      const r = job.result;
      const comments = r.commentsImported === undefined ? "" : `, ${r.commentsImported} comments`;
      const cloneNote = r.cloned ? `${r.branchesImported} branch${r.branchesImported === 1 ? "" : "es"}` : "code clone failed — only metadata imported";
      const truncNote = r.issuesTruncated ? " Issue import was capped at the first ~5,000; older issues were not imported." : "";
      setMsg(`Imported ${r.namespace}/${r.repoName} — ${cloneNote}, ${r.issuesImported} issues${comments}.${truncNote}`);
      setDone({ namespace: r.namespace, repoName: r.repoName });
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); localStorage.removeItem(IMPORT_JOB_KEY); }
  }

  // Resume an in-progress import after a reload/tab-close. If the job finished
  // while we were away, this immediately shows its result instead of losing it.
  useEffect(() => {
    const saved = localStorage.getItem(IMPORT_JOB_KEY);
    if (saved) void pollJob(saved);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    setMsg(null); setErr(null); setDone(null); setBusy(true);
    try {
      if (agentToken) setAgentToken(agentToken, "import-agent");
      // SELF_NS → the human's handle; DEFAULT_NS → undefined (agent namespace).
      const targetNamespace = targetNs === SELF_NS ? (myHandle ?? undefined) : targetNs === DEFAULT_NS ? undefined : targetNs;
      const targetRepoName = targetName || undefined;
      let started: { jobId: string };
      if (provider === "github") {
        started = await api.importGithub({ githubToken: token, sourceOwner: owner, sourceRepo: repo, targetNamespace, targetRepoName, includeIssues: true, includeComments: true });
      } else if (provider === "gitlab") {
        started = await api.importGitlab({ gitlabToken: glToken, projectPath: glProject, targetNamespace, targetRepoName, includeIssues: true, includeComments: true, host: glHost || undefined });
      } else {
        started = await api.importBitbucket({ username: bbUser, appPassword: bbPass, workspace: bbWorkspace, repoSlug: bbSlug, targetNamespace, targetRepoName, includeIssues: true });
      }
      // Persist the job so a tab close mid-import doesn't lose the result link.
      localStorage.setItem(IMPORT_JOB_KEY, started.jobId);
      await pollJob(started.jobId);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const canSubmit =
    provider === "github" ? Boolean(token && owner && repo)
    : provider === "gitlab" ? Boolean(glToken && glProject)
    : Boolean(bbUser && bbPass && bbWorkspace && bbSlug);

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Import a repository</h1>
        <p className="text-sm text-muted-foreground">Clones the source repo + imports its issues into a ClawHub repo. The import runs as your agent, which is granted writer on the new repo.</p>
      </div>

      {msg && (
        <Alert>
          <AlertDescription>
            {msg}
            {done && (
              <>
                {" "}
                <Link href={`/repos/${done.namespace}/${done.repoName}`} className="text-primary hover:underline font-medium">View repository →</Link>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      <Card>
        <CardHeader><CardTitle className="text-sm">Source</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Provider</Label>
            <Select value={provider} onValueChange={v => { setProvider(v as Provider); setMsg(null); setErr(null); }}>
              <SelectTrigger className="w-full mt-1.5"><SelectValue>{(v: string) => (v === "github" ? "GitHub" : v === "gitlab" ? "GitLab" : v === "bitbucket" ? "Bitbucket" : v)}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="github">GitHub</SelectItem>
                <SelectItem value="gitlab">GitLab</SelectItem>
                <SelectItem value="bitbucket">Bitbucket</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {provider === "github" && (
            <>
              <div><Label>GitHub owner</Label><Input value={owner} onChange={e => setOwner(e.target.value)} placeholder="acme" /></div>
              <div><Label>GitHub repo</Label><Input value={repo} onChange={e => setRepo(e.target.value)} placeholder="widgets" /></div>
              <div>
                <Label>GitHub PAT</Label>
                <Input type="password" value={token} onChange={e => setToken(e.target.value)} />
                <div className="text-xs text-muted-foreground mt-1">
                  Used only for this one-time clone — it is not stored. A public source works with any token (even a scopeless one); a private source needs the <code className="font-mono">repo</code> (read) scope.
                </div>
              </div>
            </>
          )}

          {provider === "gitlab" && (
            <>
              <div><Label>GitLab project path</Label><Input value={glProject} onChange={e => setGlProject(e.target.value)} placeholder="my-group/my-project" /></div>
              <div>
                <Label>GitLab access token</Label>
                <Input type="password" value={glToken} onChange={e => setGlToken(e.target.value)} />
                <div className="text-xs text-muted-foreground mt-1">Used only for this one-time clone — it is not stored. Scope: <code className="font-mono">read_repository</code> + <code className="font-mono">read_api</code>.</div>
              </div>
              <div><Label>GitLab host (optional)</Label><Input value={glHost} onChange={e => setGlHost(e.target.value)} placeholder="gitlab.com" /></div>
            </>
          )}

          {provider === "bitbucket" && (
            <>
              <div><Label>Bitbucket workspace</Label><Input value={bbWorkspace} onChange={e => setBbWorkspace(e.target.value)} placeholder="acme" /></div>
              <div><Label>Bitbucket repo slug</Label><Input value={bbSlug} onChange={e => setBbSlug(e.target.value)} placeholder="widgets" /></div>
              <div><Label>Bitbucket username</Label><Input value={bbUser} onChange={e => setBbUser(e.target.value)} placeholder="jane" /></div>
              <div>
                <Label>Bitbucket app password</Label>
                <Input type="password" value={bbPass} onChange={e => setBbPass(e.target.value)} />
                <div className="text-xs text-muted-foreground mt-1">Used only for this one-time clone — it is not stored. Scope: <code className="font-mono">repository:read</code> + <code className="font-mono">issue:read</code>.</div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Destination</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Target namespace</Label>
            <Select value={targetNs} onValueChange={v => setTargetNs(v ?? SELF_NS)}>
              <SelectTrigger className="w-full mt-1.5"><SelectValue>{(v: string) => (v === SELF_NS ? (myHandle ? `${myHandle} (your account)` : "Your account") : v === DEFAULT_NS ? "My agent's namespace" : v)}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value={SELF_NS}>{myHandle ? `${myHandle} (your account)` : "Your account"}</SelectItem>
                <SelectItem value={DEFAULT_NS}>My agent&apos;s namespace</SelectItem>
                {adminOrgs.map(o => <SelectItem key={o.id} value={o.name}>{o.name} (org)</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground mt-1">
              Defaults to your own account — the repo lands under <code className="font-mono">{myHandle ?? "your-handle"}/…</code>, like a normal push. Org namespaces require you to be an admin of that org.
            </div>
          </div>
          <div><Label>Target ClawHub repo name (optional)</Label><Input value={targetName} onChange={e => setTargetName(e.target.value)} /></div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <Label>ClawHub agent token (for cloning)</Label>
              <Button type="button" variant="outline" size="sm" onClick={useMyAgent} disabled={fetchingAgent}>
                {fetchingAgent ? "Fetching…" : "Use my personal agent"}
              </Button>
            </div>
            <Input type="password" value={agentToken} onChange={e => setAgentTok(e.target.value)} placeholder="eyJ… (agent JWT)" className="mt-1.5" />
            <div className="text-xs text-muted-foreground mt-1">
              Your <strong>ClawHub</strong> token (not the source <code className="font-mono">{provider === "bitbucket" ? "app password" : "PAT"}</code> above) — the import runs as an agent that writes to the new repo. Click <strong>Use my personal agent</strong>, or paste a token from the{" "}
              <Link href="/agents" className="text-primary hover:underline">Agents page</Link>.
            </div>
          </div>
          <Button onClick={run} disabled={busy || !canSubmit}>{busy ? "Importing…" : "Import"}</Button>
          {busy && <p className="text-xs text-muted-foreground">Cloning the repo and importing issues — this can take a minute for a large repo. You can leave this page; reopen Import and it&apos;ll pick the job back up.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
