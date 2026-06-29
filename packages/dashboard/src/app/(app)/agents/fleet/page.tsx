"use client";

import { useEffect, useState } from "react";
import { api, type OrgRow } from "@/lib/api";
import { AgentsHubNav } from "@/components/agents-hub-nav";
import { FleetPane, type FleetScope } from "@/components/fleet-pane";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MINE = "__mine";

// The Fleet hub tab. Scope is resolved in-page (the proven /cost Select pattern):
// "My agents" is the caller's personal fleet (getMyFleet), and each org is its
// own fleet (getOrgFleet, member-authz'd). Defaults to personal so a solo user
// — N=1 — lands on a real roster, not an empty org-only view. The canonical
// /orgs/:id/fleet route is unchanged.
export default function HubFleetPage() {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [sel, setSel] = useState<string>(MINE);   // MINE or an org id

  useEffect(() => {
    api.listOrgs().then(r => setOrgs(r.orgs)).catch(() => setOrgs([]));
  }, []);

  const scope: FleetScope = sel === MINE ? { kind: "mine" } : { kind: "org", orgId: sel };

  return (
    <div>
      <AgentsHubNav active="fleet" />
      {orgs && orgs.length > 0 && (
        <div className="flex justify-end mb-4">
          <div className="min-w-56">
            <Label className="text-xs text-muted-foreground">Scope</Label>
            <Select value={sel} onValueChange={v => { if (v) setSel(v); }}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: string) => v === MINE ? "My agents" : (orgs?.find(o => o.id === v)?.displayName || orgs?.find(o => o.id === v)?.name || v)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MINE}>My agents</SelectItem>
                {orgs.map(o => <SelectItem key={o.id} value={o.id}>{o.displayName || o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {orgs === null ? <div className="text-sm text-muted-foreground">Loading…</div> : <FleetPane scope={scope} />}
    </div>
  );
}
