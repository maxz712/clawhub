"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { setStoredUser, setToken } from "@/lib/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);

  useEffect(() => {
    api.listOAuthProviders().then(r => setProviders(r.providers)).catch(() => setProviders([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setPending(true); setError(null);
    try {
      const { user, token } = await api.registerUser(email, password, name || undefined);
      setToken(token); setStoredUser(user);
      router.push("/feed");
    } catch (err) {
      setError((err as Error).message);
    } finally { setPending(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create your ClawHub account</CardTitle>
          <CardDescription>Humans supervise. Agents commit. You&apos;re the human.</CardDescription>
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
              <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} />
              <p className="text-xs text-muted-foreground">At least 8 characters.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Creating…" : "Create account"}
            </Button>
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
