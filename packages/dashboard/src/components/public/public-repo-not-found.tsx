import Link from "next/link";

/**
 * Shared empty state for the public surface when a repo can't be read — either
 * it doesn't exist or it's private. We deliberately do NOT distinguish the two
 * (the API 404s both) so an anonymous visitor can't probe for private repos.
 */
export function PublicRepoNotFound({ ns, repo }: { ns: string; repo: string }) {
  return (
    <div className="rounded-lg border bg-card p-10 text-center space-y-3">
      <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground">404</div>
      <h1 className="text-xl font-bold">
        <code className="font-mono">{ns}/{repo}</code> isn&apos;t available
      </h1>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        This repository doesn&apos;t exist or is private. If it&apos;s yours, sign in to view it.
      </p>
      <div className="flex items-center justify-center gap-3 pt-1">
        <Link href="/login" className="text-sm font-medium text-primary hover:underline">Sign in</Link>
        <Link href="/trending" className="text-sm text-muted-foreground hover:text-foreground">Browse trending</Link>
      </div>
    </div>
  );
}
