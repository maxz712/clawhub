"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, type IdentityActivityRow, type IdentityRow } from "@/lib/api";
import { getStoredUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { IdentityChip } from "@/components/identity-chip";
import { Pencil } from "lucide-react";

/**
 * An identity profile (v3). Same page shape for humans and agents. Your own
 * profile is editable here (display name / avatar / bio) — credentials
 * (email, password, 2FA, tokens) deliberately stay in /settings: the
 * directory surface and credential management are separate.
 */
export default function IdentityProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = use(params);
  const [identity, setIdentity] = useState<IdentityRow | null>(null);
  const [sharedRepos, setSharedRepos] = useState<Array<{ ns: string | null; name: string }>>([]);
  const [activity, setActivity] = useState<IdentityActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", avatarUrl: "", bio: "" });
  const me = getStoredUser();
  const isSelf = !!identity && identity.kind === "human" && me?.username === identity.handle;

  const load = () => {
    api.getIdentity(handle)
      .then(r => {
        setIdentity(r.identity); setSharedRepos(r.sharedRepos); setError(null);
        setForm({ name: r.identity.displayName ?? "", avatarUrl: r.identity.avatarUrl ?? "", bio: r.identity.bio ?? "" });
      })
      .catch(e => setError(e instanceof Error ? e.message : "not found"));
    api.getIdentityActivity(handle).then(r => setActivity(r.activity)).catch(() => setActivity([]));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [handle]);

  if (error) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Alert variant="destructive"><AlertDescription>
          Profile not found — identities outside your shared repos and orgs are not visible.
        </AlertDescription></Alert>
      </div>
    );
  }
  if (!identity) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <Card>
        <CardContent className="pt-6 flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <IdentityChip handle={identity.handle} displayName={identity.displayName} avatarUrl={identity.avatarUrl}
              kind={identity.kind} isSystem={identity.isSystem} size="md" link={false} />
            <div className="text-xs text-muted-foreground font-mono">{identity.handle}</div>
            {identity.bio && !editing && <p className="text-sm pt-1 whitespace-pre-wrap">{identity.bio}</p>}
          </div>
          {isSelf && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5 mr-1" /> Edit profile</Button>
          )}
        </CardContent>
      </Card>

      {editing && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Edit profile</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Display name" />
            <Input value={form.avatarUrl} onChange={e => setForm(f => ({ ...f, avatarUrl: e.target.value }))} placeholder="Avatar URL" />
            <Textarea value={form.bio} onChange={e => setForm(f => ({ ...f, bio: e.target.value }))} placeholder="Bio" rows={3} />
            <p className="text-xs text-muted-foreground">
              Email, password, 2FA and API tokens live in <Link className="underline" href="/settings">account settings</Link> — this is only your public identity.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={async () => {
                await api.updateMyIdentity({ name: form.name, avatarUrl: form.avatarUrl, bio: form.bio });
                setEditing(false); load();
              }}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {sharedRepos.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Shared repos</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {sharedRepos.map(r => (
              <Link key={`${r.ns}/${r.name}`} href={`/repos/${r.ns}/${r.name}`}
                className="rounded border border-border bg-muted px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                {r.ns}/{r.name}
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">Recent activity in your shared repos</CardTitle></CardHeader>
        <CardContent>
          {activity === null && <div className="text-sm text-muted-foreground">Loading…</div>}
          {activity !== null && activity.length === 0 && <div className="text-sm text-muted-foreground">No shared activity yet.</div>}
          <ul className="space-y-2">
            {(activity ?? []).map(a => (
              <li key={a.id} className="text-sm flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground shrink-0 w-24 truncate">{new Date(a.createdAt).toLocaleDateString()}</span>
                <span className="truncate">{a.summary ?? a.kind}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
