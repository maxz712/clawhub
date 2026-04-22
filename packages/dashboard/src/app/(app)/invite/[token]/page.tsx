"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [state, setState] = useState<"idle" | "accepting" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function accept() {
    setState("accepting");
    try {
      const r = await api.acceptInvite(token);
      if (r.ok) { setState("done"); setMsg(`Joined org ${r.orgId} as ${r.role}.`); setTimeout(() => router.push(`/orgs/${r.orgId}`), 1500); }
      else { setState("error"); setMsg("Invalid invite, expired, or the invite email doesn't match your account."); }
    } catch (e) { setState("error"); setMsg((e as Error).message); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardHeader><CardTitle>Org invite</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {msg && <Alert variant={state === "error" ? "destructive" : "default"}><AlertDescription>{msg}</AlertDescription></Alert>}
          <Button onClick={accept} disabled={state === "accepting"} className="w-full">
            {state === "accepting" ? "Accepting…" : "Accept invite"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
