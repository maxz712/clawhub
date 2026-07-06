"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { setAgentToken } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CopyBlock } from "@/components/copy-block";
import { Bot, GitMerge, TriangleAlert } from "lucide-react";

/**
 * First-run onboarding card shown when a logged-in user has no agents and no
 * visible repos. Humans and agents both push code: it leads with the fastest
 * human path (`ch login` + `ch init` — push as yourself), then offers
 * connecting an agent (grab your personal agent's token), and points
 * stragglers at the onboarding skill. (v3: the claim-token flow is gone —
 * agents are created by humans, never adopted after the fact.)
 */
export function ConnectAgentCard({ onConnected }: { onConnected?: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; owner: string; token: string; created: boolean } | null>(null);

  // Use the API origin so the printed git remote points at the same backend the
  // dashboard talks to.
  const origin = api.base;

  async function createPersonal() {
    setPending(true); setError(null);
    try {
      // rotate:true guarantees a token to display even if a personal agent
      // already exists (e.g. created in another tab) — this is an explicit
      // "connect me" action, so minting a fresh credential is expected.
      const r = await api.personalAgent(true);
      if (!r.token) throw new Error("server did not return an agent token");
      setAgentToken(r.token, r.agent.name);
      // Repos land under the USER's handle (owner), not the agent name — mirror
      // what `ch init` does. Fall back to the agent name if owner is absent.
      const owner = (r as { owner?: string }).owner ?? r.agent.name;
      setIssued({ name: r.agent.name, owner, token: r.token, created: r.created });
      onConnected?.();
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Bot className="h-4.5 w-4.5" />
          </span>
          <CardTitle className="text-lg">Start pushing code</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground mt-1.5">
          Humans and agents both commit on ClawHub. Push your own code in one command with{" "}
          <code className="font-mono text-foreground">ch login</code> + <code className="font-mono text-foreground">ch init</code>,
          or connect an agent to push for you. Either way, a human owns every merge above low risk.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

        {issued ? (
          <div className="space-y-4">
            <div className="text-sm">
              {issued.created
                ? <>Personal agent <code className="font-mono text-primary">{issued.name}</code> created.</>
                : <>Using your personal agent <code className="font-mono text-primary">{issued.name}</code>.</>}
            </div>

            <Alert>
              <TriangleAlert className="h-4 w-4" />
              <AlertDescription>
                Copy this token now — it is shown <strong>once</strong> and cannot be retrieved later. Rotate it from the
                agent page if you lose it.
              </AlertDescription>
            </Alert>
            <CopyBlock label="Agent token" value={issued.token} />

            <div className="space-y-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Push your first repo</div>
              <p className="text-xs text-muted-foreground">
                The token authenticates pushes directly over plain git — point your remote at it and push any branch.
                The first branch you push becomes the repo&apos;s default branch.
              </p>
              <CopyBlock value={`git remote add origin ${origin.replace(/^(https?):\/\//, "$1://agent-token:" + issued.token + "@")}/${issued.owner}/<repo>.git`} />
              <CopyBlock value="git push -u origin HEAD" />
            </div>

            <Alert>
              <GitMerge className="h-4 w-4" />
              <AlertDescription>
                <strong>After you push:</strong> your change waits for review. You&apos;re the human supervisor —
                open it under <Link href="/repos" className="text-primary hover:underline">your repos</Link>, then approve and merge it
                (self-approving your own work is expected for solo repos).
              </AlertDescription>
            </Alert>

            <div className="space-y-1">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">…or use the CLI instead</div>
              <p className="text-xs text-muted-foreground">
                Prefer the terminal? <code className="font-mono">npm install -g useclawhub</code>, then <code className="font-mono text-foreground">ch login</code> and
                run <code className="font-mono text-foreground">ch init</code> inside a project. This wires up your agent for you and mints its
                <strong> own</strong> fresh token — so use it <strong>instead</strong> of the manual remote above, not on top of it
                (running <code className="font-mono">ch init</code> rotates the token, invalidating the one shown here).
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* PRIMARY human path: push your own code as yourself, no agent. */}
            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Push your own code</div>
              <p className="text-xs text-muted-foreground">
                Install the CLI, log in, then <code className="font-mono text-foreground">ch init</code> inside a project — you push as
                yourself with your user token. The first branch you push becomes the repo&apos;s default branch.
              </p>
              <CopyBlock value="npm install -g useclawhub" />
              <CopyBlock value="ch login" />
              <CopyBlock value="ch init" />
              <CopyBlock value="git push -u origin HEAD" />
            </div>

            {/* SECONDARY: connect an agent to push on your behalf. */}
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground pt-1">Or connect an agent</div>
            <Button className="gap-2" onClick={createPersonal} disabled={pending}>
              <Bot className="h-4 w-4" />
              {pending ? "Creating…" : "Create my personal agent"}
            </Button>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm pt-1">
              <Link href="/skill.md" target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground transition-colors">
                View the raw skill file (feed it to your agent)
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
