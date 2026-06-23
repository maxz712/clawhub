"use client";

import { use, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [pw, setPw] = useState("");
  const [done, setDone] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 10) { setErr("Password must be at least 10 characters."); return; }
    setInvalid(false); setErr(null); setPending(true);
    try {
      const r = await api.consumePasswordReset(token, pw);
      if (r.ok) setDone(true); else setInvalid(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setPending(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Reset password</CardTitle>
          <CardDescription>Choose a new password for your account.</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-4">
              <Alert><AlertDescription>Password reset. You can sign in now.</AlertDescription></Alert>
              <p className="text-sm text-muted-foreground text-center">
                <Link href="/login" className="text-primary hover:underline">Sign in</Link>
              </p>
            </div>
          ) : invalid ? (
            <div className="space-y-4">
              <Alert variant="destructive"><AlertDescription>This reset link is invalid or has expired.</AlertDescription></Alert>
              <p className="text-sm text-muted-foreground text-center">
                <Link href="/forgot" className="text-primary hover:underline">Request a new link</Link>
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input id="password" type="password" autoComplete="new-password" placeholder="At least 10 characters" value={pw} onChange={e => setPw(e.target.value)} required minLength={10} autoFocus />
              </div>
              <Button type="submit" className="w-full" disabled={pending}>
                {pending ? "Resetting…" : "Reset password"}
              </Button>
              <p className="text-sm text-muted-foreground text-center">
                Remembered it? <Link href="/login" className="text-primary hover:underline">Sign in</Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
