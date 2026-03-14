"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { setToken, setStoredUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2 } from "lucide-react";

export default function GoogleCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");

  useEffect(() => {
    const code = searchParams.get("code");

    if (!code) {
      setError("No authorization code received from Google.");
      return;
    }

    let cancelled = false;
    const redirectUri =
      window.location.origin + "/auth/callback/google";

    (async () => {
      try {
        const data = await api.oauthGoogle(code, redirectUri);
        if (cancelled) return;
        setToken(data.token);
        if (data.user) setStoredUser(data.user);
        router.push("/dashboard");
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Google authentication failed"
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams, router]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-card border-border">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Authentication Failed</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <p className="text-center text-sm text-muted-foreground mt-6">
              <Link
                href="/login"
                className="text-primary hover:underline font-medium"
              >
                Back to Sign In
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-card border-border">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
          <p className="text-sm text-muted-foreground">
            Completing Google sign in...
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
