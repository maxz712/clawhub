"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, type SastFindingRow, type VulnFinding } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function sevColor(s: string) {
  if (s === "critical") return "destructive";
  if (s === "high") return "destructive";
  if (s === "medium") return "secondary";
  return "outline";
}

export default function RepoSecurityPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [vulns, setVulns] = useState<VulnFinding[]>([]);
  const [sast, setSast] = useState<SastFindingRow[]>([]);

  async function load() {
    const [v, s] = await Promise.all([api.listVulns(ns, repo), api.listSast(ns, repo)]);
    setVulns(v.findings); setSast(s.findings);
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ns, repo]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Security · {ns}/{repo}</h1>
        <p className="text-sm text-muted-foreground">Dependency advisories + SAST findings. Fix them, then click Resolve.</p>
      </div>

      <Tabs defaultValue="vulns">
        <TabsList>
          <TabsTrigger value="vulns">Dependencies ({vulns.length})</TabsTrigger>
          <TabsTrigger value="sast">SAST ({sast.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="vulns" className="space-y-2">
          {vulns.length === 0 && <Card><CardContent className="pt-4 text-sm text-muted-foreground">No vulnerable dependencies detected.</CardContent></Card>}
          {vulns.map(v => (
            <Card key={v.id} className={v.status === "resolved" ? "opacity-60" : ""}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex flex-wrap items-center gap-2">
                  <Badge variant={sevColor(v.advisory.severity)}>{v.advisory.severity}</Badge>
                  <code className="font-mono">{v.advisory.identifier}</code>
                  <span className="text-muted-foreground font-normal">— {v.advisory.packageName}@{v.installedVersion}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>{v.advisory.summary}</p>
                <div className="text-xs font-mono text-muted-foreground">
                  manifest: {v.manifestPath} · patched: {v.advisory.patchedRange ?? "—"}
                </div>
                <div className="flex gap-2">
                  {v.advisory.url && <a href={v.advisory.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">Advisory →</a>}
                  {v.status !== "resolved" && <Button size="sm" variant="outline" onClick={async () => { await api.resolveVuln(ns, repo, v.id); void load(); }}>Resolve</Button>}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="sast" className="space-y-2">
          {sast.length === 0 && <Card><CardContent className="pt-4 text-sm text-muted-foreground">No SAST findings. Seed default rules if you haven&apos;t yet.</CardContent></Card>}
          {sast.map(f => (
            <Card key={f.id} className={f.status === "resolved" ? "opacity-60" : ""}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex flex-wrap items-center gap-2">
                  <Badge variant={sevColor(f.severity)}>{f.severity}</Badge>
                  <code className="font-mono text-xs">{f.rule.identifier}</code>
                  <span className="text-muted-foreground font-normal">{f.path}:{f.line}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>{f.rule.message}</p>
                {f.excerpt && <pre className="text-xs font-mono bg-muted/40 border border-border rounded p-2 overflow-x-auto">{f.excerpt}</pre>}
                <div className="flex gap-2 items-center">
                  {f.changeId && <Link className="text-xs text-primary underline" href={`/repos/${ns}/${repo}/changes/${f.changeId}`}>View change →</Link>}
                  {f.status !== "resolved" && <Button size="sm" variant="outline" onClick={async () => { await api.resolveSast(ns, repo, f.id); void load(); }}>Resolve</Button>}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
