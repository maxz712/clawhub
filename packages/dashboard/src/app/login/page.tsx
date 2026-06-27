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

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  google: "Google",
};

function providerLabel(p: string): string {
  return PROVIDER_LABELS[p] ?? (p.charAt(0).toUpperCase() + p.slice(1));
}

// Build the OAuth start URL, forwarding `next` (and `plan` if present) so the
// post-OAuth redirect lands where the password flow would.
function oauthStartUrl(p: string, params: Record<string, string | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const query = qs.toString();
  const base = `${api.base}/api/v1/oauth/${p}/start`;
  return query ? `${base}?${query}` : base;
}

const OAUTH_ERRORS: Record<string, string> = {
  oauth_state_mismatch: "Sign-in expired — please try again.",
  oauth_denied: "Sign-in was cancelled.",
  oauth_token_exchange_failed: "The provider rejected the sign-in. Try again.",
  oauth_no_verified_email: "Your account has no verified email address.",
  oauth_failed: "Sign-in failed. Try again.",
};

export default function LoginPage() {
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);

  useEffect(() => {
    const err = search.get("error");
    if (err) setError(OAUTH_ERRORS[err] ?? "Sign-in failed.");
    api.listOAuthProviders().then(r => setProviders(r.providers)).catch(() => setProviders([]));
  }, [search]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true); setError(null);
    try {
      const { user, token } = await api.loginUser(email, password);
      setToken(token); setStoredUser(user);
      router.push(safeInternalPath(search.get("next")) ?? "/feed");
    } catch (err) {
      setError((err as Error).message);
    } finally { setPending(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in to ClawHub</CardTitle>
          <CardDescription>Humans sign in to supervise. New to ClawHub? <Link href="/register" className="text-primary hover:underline">Create an account</Link> to get started.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus className="h-11" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link href="/forgot" className="text-xs text-muted-foreground hover:text-primary">Forgot password?</Link>
              </div>
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required className="h-11" />
            </div>
            <Button type="submit" className="w-full h-11" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-sm text-muted-foreground text-center">
              No account? <Link href="/register" className="text-primary hover:underline">Register</Link>
            </p>
          </form>
          {providers.length > 0 && (
            <div className="mt-4 pt-4 border-t space-y-2">
              <p className="text-xs text-muted-foreground text-center font-medium uppercase tracking-wider">or continue with</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                {providers.map(p => (
                  <Button key={p} variant="outline" className="flex-1 min-w-0"
                    onClick={() => { window.location.href = oauthStartUrl(p, { next: search.get("next"), plan: search.get("plan") }); }}>
                    Continue with {providerLabel(p)}
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
