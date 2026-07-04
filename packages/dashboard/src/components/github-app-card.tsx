"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Github, CheckCircle2, ExternalLink } from "lucide-react";

/**
 * GitHub App (N2) connection card. Shows whether the useclawhub App is wired up
 * on this instance and links to install it on a GitHub repo. Once installed +
 * granted a repo, ClawHub mirrors that repo's PRs and posts an advisory review
 * check back — no ClawHub push, no config in the GitHub repo.
 */
export function GithubAppCard() {
  const [status, setStatus] = useState<{ configured: boolean; slug: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api.githubAppStatus().then(setStatus).catch(() => setStatus({ configured: false, slug: "useclawhub" })).finally(() => setLoaded(true));
  }, []);

  if (!loaded) return null;
  const slug = status?.slug ?? "useclawhub";
  const installUrl = `https://github.com/apps/${slug}/installations/new`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-1.5"><Github className="h-4 w-4" /> GitHub App — mirror &amp; review PRs</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground text-xs">
          Install the ClawHub GitHub App on a repo and every pull request is mirrored into a private
          shadow repo, reviewed + verified by ClawHub&apos;s agents, and the verdict is posted back as an
          advisory check-run + comment. The App&apos;s key never leaves ClawHub&apos;s API — nothing runs in a
          GitHub Action, and nothing is pushed to your repo.
        </p>
        <div className="flex items-center gap-2">
          {status?.configured
            ? <span className="flex items-center gap-1 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" /> App configured on this instance</span>
            : <span className="text-xs text-amber-500">App not configured on this instance</span>}
        </div>
        <a
          href={installUrl}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!status?.configured}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "inline-flex items-center gap-1.5", !status?.configured && "pointer-events-none opacity-50")}
        >
          Install on GitHub <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </CardContent>
    </Card>
  );
}
