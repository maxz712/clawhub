"use client";

import { useEffect, useState } from "react";
import { api, type User } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function UserSettingsPage() {
  const [me, setMe] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.getMe().then(setMe).catch(e => setError((e as Error).message)); }, []);

  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <Card>
        <CardHeader><CardTitle className="text-sm">Account</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-2">
          {!me ? <div className="text-muted-foreground">Loading…</div> : (
            <>
              <div><span className="text-muted-foreground">Email:</span> {me.email}</div>
              {me.name && <div><span className="text-muted-foreground">Name:</span> {me.name}</div>}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
