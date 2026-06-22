"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type MergePolicy } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MergePolicyEditor } from "@/components/merge-policy-editor";
import { ShieldCheck } from "lucide-react";

// The org-default merge policy. It seeds NEW org repos at creation; a per-repo
// policy + an in-repo .clawhub/policies/merge.yml still override afterward. Only
// admins can edit; members see it read-only context via the description.
const DEFAULT: MergePolicy = {
  requireHumanApproval: "if_risk_at_least",
  requireHumanApprovalLevel: "medium",
  minApprovalsTotal: 1,
  minApprovalsHuman: 1,
  allowSelfReview: false,
  ciRequired: true,
  codeReviewRequiredAtRisk: "high",
  pathOverrides: [],
  trustedAgents: [],
};

export function OrgMergePolicyCard({ orgId, isAdmin }: { orgId: string; isAdmin: boolean }) {
  const [policy, setPolicy] = useState<MergePolicy | null>(null);
  const [isSet, setIsSet] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.getOrgMergePolicyDefault(orgId);
      setIsSet(!!r.policy);
      setPolicy(r.policy ?? DEFAULT);
    } catch (e) { setError((e as Error).message); }
    finally { setLoaded(true); }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  async function save(p: MergePolicy) {
    setError(null); setNotice(null);
    await api.setOrgMergePolicyDefault(orgId, p);
    setIsSet(true);
    setNotice("Saved. New repos in this org will start from this policy.");
  }
  async function clearDefault() {
    setError(null); setNotice(null);
    try { await api.clearOrgMergePolicyDefault(orgId); setNotice("Cleared. New repos use the system default."); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  if (!isAdmin) return null; // members don't manage org-wide governance here

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" /> Default merge policy
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Applied to <strong>new</strong> repos created in this org. A per-repo policy or an in-repo{" "}
          <code className="font-mono">.clawhub/policies/merge.yml</code> overrides it afterward. {isSet
            ? "A custom default is set."
            : "No custom default — new repos use the system default (shown below as a starting point)."}
        </p>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
        {!loaded || !policy
          ? <div className="text-sm text-muted-foreground">Loading…</div>
          : <MergePolicyEditor initial={policy} onSave={save} isOrg />}
        {isSet && (
          <Button variant="ghost" size="sm" onClick={() => void clearDefault()}>
            Clear org default (revert new repos to system default)
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
