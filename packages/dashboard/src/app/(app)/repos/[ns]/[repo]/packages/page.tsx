"use client";

import { use, useEffect, useState } from "react";
import { api, type PackageRow, type PackageVersionRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyBlock } from "@/components/copy-block";

export default function RepoPackagesPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [rows, setRows] = useState<PackageRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, PackageVersionRow[]>>({});

  useEffect(() => { void api.listPackages(ns, repo).then(r => setRows(r.packages)); }, [ns, repo]);

  async function toggle(pkg: PackageRow) {
    if (expanded === pkg.id) { setExpanded(null); return; }
    setExpanded(pkg.id);
    if (!versions[pkg.id]) {
      const r = await api.listPackageVersions(ns, repo, pkg.kind, pkg.name);
      setVersions(prev => ({ ...prev, [pkg.id]: r.versions }));
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Packages</h1>
        <p className="text-sm text-muted-foreground">Generic + npm-compatible registry. Agents publish via REST; downloads go through the public repo URL.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Publish a package</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-xs">
          <p className="text-muted-foreground">Upload a generic package file (replace the version/filename and point at your file):</p>
          <CopyBlock value={`curl -X POST "${api.base}/api/v1/repos/${ns}/${repo}/packages/generic/my-pkg/versions/1.0.0/files/my-pkg-1.0.0.tgz" \\\n  -H "authorization: Bearer eyJ..." \\\n  --data-binary @my-pkg-1.0.0.tgz`} />
          <p className="text-muted-foreground">Or publish an npm-compatible package by pointing your registry at this repo:</p>
          <CopyBlock value={`npm publish --registry ${api.base}/api/v1/repos/${ns}/${repo}/-/npm/`} />
          <p className="text-muted-foreground">
            Full request schemas live in the{" "}
            <a href={`${api.base}/api/v1/openapi/ui`} target="_blank" rel="noreferrer" className="text-primary hover:underline">API reference</a>.
          </p>
        </CardContent>
      </Card>

      {rows.length === 0 && <Card><CardContent className="pt-4 text-sm text-muted-foreground">No packages published yet.</CardContent></Card>}

      <div className="space-y-2">
        {rows.map(pkg => (
          <Card key={pkg.id}>
            <CardHeader className="pb-2 cursor-pointer" onClick={() => void toggle(pkg)}>
              <CardTitle className="text-sm flex items-center gap-2">
                <Badge variant="outline">{pkg.kind}</Badge>
                <span className="font-mono">{pkg.name}</span>
              </CardTitle>
            </CardHeader>
            {expanded === pkg.id && (
              <CardContent className="space-y-2 text-xs font-mono">
                {(versions[pkg.id] ?? []).map(v => (
                  <div key={v.id} className="flex items-center justify-between border-t border-border pt-1">
                    <span>{v.version}</span>
                    <span className="text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</span>
                    <Button size="sm" variant="ghost" onClick={async () => { await api.deletePackageVersion(ns, repo, pkg.kind, pkg.name, v.version); const r = await api.listPackageVersions(ns, repo, pkg.kind, pkg.name); setVersions(prev => ({ ...prev, [pkg.id]: r.versions })); }}>
                      Delete
                    </Button>
                  </div>
                ))}
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
