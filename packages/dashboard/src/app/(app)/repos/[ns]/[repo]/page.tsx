"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, type Repo } from "@/lib/api";
import { getAgentToken } from "@/lib/auth";
import { TreeListing } from "@/components/tree-listing";
import { CodeSearchBox } from "@/components/code-search-box";
import { CopyBlock } from "@/components/copy-block";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function RepoHomePage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [data, setData] = useState<{ repo: Repo } | null>(null);
  // null = unknown yet; [] = a repo with no branches (no commits pushed).
  const [branchNames, setBranchNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The RepoHeader + Changes/Issues counts now live in the repo layout, so the
    // home page only needs the repo (for the default branch) + the branch list.
    api.getRepo(ns, repo).then(setData).catch(e => setError((e as Error).message));
    // Branch list drives the empty-repo state: a repo with no branches has no
    // commits yet, so the tree fetch would 404 — we render onboarding instead.
    api.getBranches(ns, repo).then(r => setBranchNames(r.branches.map(b => b.name))).catch(() => setBranchNames([]));
  }, [ns, repo]);

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!data || branchNames === null) return <div className="text-muted-foreground">Loading…</div>;

  const isEmpty = branchNames.length === 0;

  // Agent remote: if the user has an agent token stored, drop it into the URL so
  // it's copy-paste ready; otherwise show the <TOKEN> placeholder and point them
  // at the Agents page to get one. The displayed token is masked; copy carries it
  // in full. Humans push with their OWN user token (via `ch login`/`ch init`), so
  // the agent remote is the SECONDARY path here — the primary is "push as you".
  const token = getAgentToken();
  const agentRemoteUrl = (tok: string) => api.base.replace(/^(https?):\/\//, `$1://agent-token:${tok}@`) + `/${ns}/${repo}.git`;
  const maskedToken = token ? token.slice(0, 6) + "…" + token.slice(-4) : "<TOKEN>";
  const agentRemoteMasked = agentRemoteUrl(maskedToken);
  const agentRemoteFull = agentRemoteUrl(token ?? "<TOKEN>");
  // Plain clone URL (no embedded credential) — git prompts for Basic auth, where
  // a human enters their handle + user token, or `agent-token` + an agent token.
  const plainUrl = api.base + `/${ns}/${repo}.git`;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-3 space-y-4">
        {isEmpty ? (
          <>
            {/* PRIMARY: push your own code as yourself, no agent setup. */}
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Push your own code</div>
              <p className="text-xs text-muted-foreground">
                Log in once, then <code className="font-mono text-foreground">ch init</code> wires this repo&apos;s remote and you push as yourself.
                The first branch you push becomes the repo&apos;s default branch.
              </p>
              <CopyBlock value="ch login" />
              <CopyBlock value="ch init" />
              <CopyBlock value="git push -u origin HEAD" />
            </div>

            {/* SECONDARY: connect an agent to push on your behalf. */}
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Or connect an agent</div>
                {!token && <Link href="/agents" className="text-xs text-primary hover:underline">Get an agent token</Link>}
              </div>
              <p className="text-xs text-muted-foreground">
                Agents push with an agent token — Basic-auth username <code className="font-mono">agent-token</code>, password the agent JWT.
                {!token && <> Substitute your agent&apos;s token for <code className="font-mono">&lt;TOKEN&gt;</code>.</>}
              </p>
              <CopyBlock value={`git remote add origin ${agentRemoteFull}`} display={`git remote add origin ${agentRemoteMasked}`} />
              <CopyBlock value="git push -u origin HEAD" />
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Clone</div>
            <CopyBlock value={`git clone ${plainUrl}`} />
            <p className="text-xs text-muted-foreground">
              Push as yourself (handle + user token at the git prompt, or <code className="font-mono text-foreground">ch login</code>),
              or as an agent (username <code className="font-mono">agent-token</code>). Both flow through the same review + merge policy.
            </p>
          </div>
        )}
      </div>

      {isEmpty ? (
        <div className="rounded-lg border bg-card p-8 text-center space-y-2">
          <div className="text-base font-medium">No code yet</div>
          <p className="text-sm text-muted-foreground">
            Push your first branch to get started — the first branch you push becomes the repo&apos;s default branch.
            Use the commands above, or run <code className="font-mono text-foreground">ch init</code> from the CLI.
          </p>
        </div>
      ) : (
        <>
          <CodeSearchBox ns={ns} repo={repo} refName={data.repo.defaultBranch} />
          <TreeListing ns={ns} repo={repo} refName={data.repo.defaultBranch} path="" />
        </>
      )}
    </div>
  );
}
