"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { setStoredUser, setToken } from "@/lib/auth";

// OAuth landing: the API redirects here with the session JWT in the URL
// fragment (fragments are never sent to servers or logged). Store it, load
// the profile, and continue to the app.
export default function OAuthLandingPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (!token) { setError("Missing token — try signing in again."); return; }
    setToken(token);
    history.replaceState(null, "", "/login/oauth"); // drop the fragment
    api.getMe()
      .then(user => { setStoredUser(user); router.replace("/feed"); })
      .catch(() => setError("Could not load your profile — try signing in again."));
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-sm">
      {error
        ? <div className="text-destructive">{error} <a href="/login" className="text-primary hover:underline ml-1">Back to sign in</a></div>
        : <div className="text-muted-foreground">Signing you in…</div>}
    </div>
  );
}
