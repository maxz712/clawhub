"use client";

import { useEffect, useState } from "react";
import { api, type NotificationPrefs } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function NotificationsPage() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.getNotificationPrefs().then(r => setPrefs(r.prefs));
  }, []);

  async function update(patch: Partial<NotificationPrefs>) {
    if (!prefs) return;
    setSaving(true);
    try {
      const r = await api.updateNotificationPrefs(patch);
      setPrefs(r.prefs);
    } finally { setSaving(false); }
  }

  if (!prefs) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground">Control when ClawHub emails you.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Email</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Toggle label="Enable email notifications" checked={prefs.email} onChange={v => update({ email: v })} />
          <Toggle label="When I'm @-mentioned" checked={prefs.emailOnMention} onChange={v => update({ emailOnMention: v })} disabled={!prefs.email} />
          <Toggle label="When my review is requested" checked={prefs.emailOnReviewRequested} onChange={v => update({ emailOnReviewRequested: v })} disabled={!prefs.email} />
          <Toggle label="When a change is merged in a watched repo" checked={prefs.emailOnChangeMerged} onChange={v => update({ emailOnChangeMerged: v })} disabled={!prefs.email} />
          <Toggle label="When CI fails on my change" checked={prefs.emailOnCiFailure} onChange={v => update({ emailOnCiFailure: v })} disabled={!prefs.email} />

          <div className="pt-2">
            <Label>Digest</Label>
            <Select value={prefs.digestFrequency} onValueChange={v => update({ digestFrequency: v ?? "never" })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Never</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {saving && <div className="text-xs text-muted-foreground">Saving…</div>}
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center justify-between gap-3 text-sm ${disabled ? "opacity-40" : ""}`}>
      <span>{label}</span>
      <Button type="button" variant={checked ? "default" : "outline"} size="sm" disabled={disabled} onClick={() => onChange(!checked)}>
        {checked ? "On" : "Off"}
      </Button>
    </label>
  );
}
