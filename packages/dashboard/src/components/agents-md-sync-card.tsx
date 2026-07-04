"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FileText, CheckCircle2 } from "lucide-react";

/**
 * AGENTS.md auto-sync (N5, server-authored-Change primitive). Opens a Change that
 * updates the repo's AGENTS.md clawhub:begin/end block to the current canonical
 * trailer-convention docs — authored by ClawHub itself, merged by a human.
 */
export function AgentsMdSyncCard({ ns, repo }: { ns: string; repo: string }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ changed: boolean; changeId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    setPending(true); setError(null); setResult(null);
    try { setResult(await api.syncAgentsMd(ns, repo)); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-1.5"><FileText className="h-4 w-4" /> AGENTS.md sync</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {error && <Alert variant="destructive"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}
        <p className="text-xs text-muted-foreground">
          Keep this repo&apos;s <code className="font-mono">AGENTS.md</code> current with ClawHub&apos;s canonical
          trailer-convention block so foreign agents learn the conventions repo-side. ClawHub authors the
          Change; a human still owns the merge.
        </p>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => void sync()} disabled={pending}>{pending ? "Opening…" : "Sync AGENTS.md"}</Button>
          {result && (result.changed
            ? <span className="flex items-center gap-1 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" />
                {result.changeId
                  ? <Link href={`/repos/${ns}/${repo}/changes/${result.changeId}`} className="underline hover:text-foreground">Change opened →</Link>
                  : "Change opened"}
              </span>
            : <span className="text-xs text-muted-foreground">Already up to date.</span>)}
        </div>
      </CardContent>
    </Card>
  );
}
