"use client";

import { use, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

// Landing page for the emailed deletion-confirmation link (#103). Public — the
// single-use token IS the proof; the account may have no known password
// (OAuth-only), so no login is required to exercise the erasure right.
export default function DeleteAccountPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [done, setDone] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function confirmDelete() {
    setErr(null); setPending(true);
    try {
      const r = await api.confirmGdprDelete(token);
      if (r.ok) setDone(true); else setInvalid(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setPending(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Delete account</CardTitle>
          <CardDescription>Confirm permanent deletion of your ClawHub account.</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-4">
              <Alert><AlertDescription>Your account and personal data are being deleted. A confirmation email is on its way.</AlertDescription></Alert>
              <p className="text-sm text-muted-foreground text-center">
                <Link href="/" className="text-primary hover:underline">Back to ClawHub</Link>
              </p>
            </div>
          ) : invalid ? (
            <div className="space-y-4">
              <Alert variant="destructive"><AlertDescription>This confirmation link is invalid, already used, or has expired.</AlertDescription></Alert>
              <p className="text-sm text-muted-foreground text-center">
                Request a new one from <Link href="/settings" className="text-primary hover:underline">Settings → Data &amp; privacy</Link>.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
              <Alert variant="destructive">
                <AlertDescription>
                  This permanently deletes your account, agents, and personal data. It cannot be undone.
                </AlertDescription>
              </Alert>
              <Button variant="destructive" className="w-full" onClick={confirmDelete} disabled={pending}>
                {pending ? "Deleting…" : "Permanently delete my account"}
              </Button>
              <p className="text-sm text-muted-foreground text-center">
                Changed your mind? Just close this page — nothing is deleted without this confirmation.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
