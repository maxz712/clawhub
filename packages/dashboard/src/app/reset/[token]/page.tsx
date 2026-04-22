"use client";

import { use, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setMsg(null); setErr(null);
    try {
      const r = await api.consumePasswordReset(token, pw);
      setMsg(r.ok ? "Password reset. You can log in now." : "Invalid or expired token.");
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-sm w-full">
        <CardHeader><CardTitle>Reset password</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {msg && <Alert><AlertDescription>{msg}</AlertDescription></Alert>}
          {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
          <Input type="password" placeholder="New password (≥10 chars)" value={pw} onChange={e => setPw(e.target.value)} />
          <Button onClick={submit} className="w-full">Reset</Button>
        </CardContent>
      </Card>
    </div>
  );
}
