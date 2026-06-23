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
import { getAgentToken, setAgentToken } from "@/lib/auth";

type Provider = "github" | "gitlab" | "bitbucket";

// The selector's default value — submit no targetNamespace, so the backend
// imports into the calling agent's own service-user namespace (legacy default).
const DEFAULT_NS = "__default__";

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
  const [targetNs, setTargetNs] = useState<string>(DEFAULT_NS);
  const [adminOrgs, setAdminOrgs] = useState<OrgRow[]>([]);
  const [agentToken, setAgentTok] = useState(() => getAgentToken() ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetchingAgent, setFetchingAgent] = useState(false);

  // Target-namespace options: the agent's own namespace (default) plus the orgs
  // the caller ADMINS — the only org namespaces the backend will let the agent
  // create a repo in (mirrors the org-admin create gate).
  useEffect(() => {
    api.listOrgs()
      .then(r => setAdminOrgs(r.orgs.filter(o => o.role === "admin")))
      .catch(() => { /* not logged in / no orgs — default namespace still works */ });
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

  async function run() {
    setMsg(null); setErr(null); setBusy(true);
    try {
      if (agentToken) setAgentToken(agentToken, "import-agent");
      const targetNamespace = targetNs === DEFAULT_NS ? undefined : targetNs;
      const targetRepoName = targetName || undefined;
      let r: { repoName: string; cloned: boolean; issuesImported: number; commentsImported?: number };
      if (provider === "github") {
        r = await api.importGithub({ githubToken: token, sourceOwner: owner, sourceRepo: repo, targetNamespace, targetRepoName, includeIssues: true, includeComments: true });
      } else if (provider === "gitlab") {
        r = await api.importGitlab({ gitlabToken: glToken, projectPath: glProject, targetNamespace, targetRepoName, includeIssues: true, includeComments: true, host: glHost || undefined });
      } else {
        r = await api.importBitbucket({ username: bbUser, appPassword: bbPass, workspace: bbWorkspace, repoSlug: bbSlug, targetNamespace, targetRepoName, includeIssues: true });
      }
      const comments = r.commentsImported === undefined ? "" : `, comments: ${r.commentsImported}`;
      setMsg(`Imported ${r.repoName}. Cloned: ${r.cloned}. Issues: ${r.issuesImported}${comments}.`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
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

      {msg && <Alert><AlertDescription>{msg}</AlertDescription></Alert>}
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
                  Used only for this one-time clone — it is not stored. Minimum scope: <code className="font-mono">repo</code> (read) for a private source; a public repo needs no scope.
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
            <Select value={targetNs} onValueChange={v => setTargetNs(v ?? DEFAULT_NS)}>
              <SelectTrigger className="w-full mt-1.5"><SelectValue>{(v: string) => (v === DEFAULT_NS ? "My agent's namespace (default)" : v)}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_NS}>My agent&apos;s namespace (default)</SelectItem>
                {adminOrgs.map(o => <SelectItem key={o.id} value={o.name}>{o.name} (org)</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground mt-1">
              Org namespaces require you to be an admin of the org. Leave as the default to import into your agent&apos;s own namespace.
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
              The import runs as an agent. Click <strong>Use my personal agent</strong> above, or paste a token from the{" "}
              <Link href="/agents" className="text-primary hover:underline">Agents page</Link>.
            </div>
          </div>
          <Button onClick={run} disabled={busy || !canSubmit}>Import</Button>
        </CardContent>
      </Card>
    </div>
  );
}
