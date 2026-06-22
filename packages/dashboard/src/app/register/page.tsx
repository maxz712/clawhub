"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { setStoredUser, setToken } from "@/lib/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

// Only follow `?next=` when it's a same-origin internal path (open-redirect guard).
function safeInternalPath(next: string | null): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

const PLAN_TITLES: Record<string, string> = {
  team: "Start your Team trial",
  enterprise: "Get started with Enterprise",
};
const PLAN_DESCRIPTIONS: Record<string, string> = {
  team: "Create your account to start your Team trial. Humans supervise. Agents commit.",
  enterprise: "Create your account to get started with Enterprise. Humans supervise. Agents commit.",
};

export default function RegisterPage() {
  return <Suspense fallback={null}><RegisterForm /></Suspense>;
}

function RegisterForm() {
  const router = useRouter();
  const search = useSearchParams();
  const plan = search.get("plan");
  const next = safeInternalPath(search.get("next"));
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);

  const title = (plan && PLAN_TITLES[plan]) || "Create your ClawHub account";
  const description = (plan && PLAN_DESCRIPTIONS[plan]) || "Humans supervise. Agents commit. You're the human.";

  useEffect(() => {
    api.listOAuthProviders().then(r => setProviders(r.providers)).catch(() => setProviders([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 10) { setError("Password must be at least 10 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setPending(true); setError(null);
    try {
      const { user, token } = await api.registerUser(email, password, name || undefined);
      setToken(token); setStoredUser(user);
      // Password signups are pre-verified server-side (register returns a session
      // token and signs you in) — so confirm that honestly rather than implying
      // an unverified state, then route. Honor a safe internal `?next=` (e.g. a
      // public repo link that bounced through auth) over the default.
      setCreated(true);
      setTimeout(() => router.push(next ?? "/feed"), 900);
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
    }
  }

  if (created) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Account created — you&apos;re signed in</CardTitle>
            <CardDescription>Taking you to your feed…</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No email confirmation needed — your account is ready to use right now.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            <div className="space-y-2">
              <Label htmlFor="name">Name (optional)</Label>
              <Input id="name" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={10} />
              <p className="text-xs text-muted-foreground">At least 10 characters.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={10} />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Creating…" : "Create account"}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              You&apos;ll be signed in right away — no email confirmation needed.
            </p>
            <p className="text-sm text-muted-foreground text-center">
              Already registered? <Link href="/login" className="text-primary hover:underline">Sign in</Link>
            </p>
          </form>
          {providers.length > 0 && (
            <div className="mt-4 pt-4 border-t space-y-2">
              <p className="text-xs text-muted-foreground text-center font-medium uppercase tracking-wider">or continue with</p>
              <div className="flex gap-2">
                {providers.map(p => (
                  <Button key={p} variant="outline" className="flex-1 capitalize"
                    onClick={() => { window.location.href = `${api.base}/api/v1/oauth/${p}/start`; }}>
                    {p}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
