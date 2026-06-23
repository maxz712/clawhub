import Link from "next/link";
import { ChevronRight } from "lucide-react";

export type Crumb = { label: string; href?: string };

/**
 * Generic breadcrumb trail for deep repo pages (change/issue detail), where the
 * persistent RepoHeader establishes repo identity but not "where in this repo am
 * I". Takes an arbitrary {label, href}[] — the last crumb renders as the current
 * page (no link, aria-current). Linked crumbs point back up the hierarchy
 * (e.g. "Changes" → the change list) so the user isn't forced onto browser-back.
 */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap min-w-0">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
            {c.href && !last
              ? <Link href={c.href} className="hover:text-foreground truncate">{c.label}</Link>
              : <span className={`truncate ${last ? "text-foreground" : ""}`} aria-current={last ? "page" : undefined}>{c.label}</span>}
          </span>
        );
      })}
    </nav>
  );
}
