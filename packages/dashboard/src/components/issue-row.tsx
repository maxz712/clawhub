import Link from "next/link";
import type { Issue } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

export function IssueRow({ issue, href }: { issue: Issue; href: string }) {
  return (
    <Link href={href} className="block">
      <div className="flex items-center gap-3 p-3 rounded border bg-card hover:bg-accent transition-colors">
        <code className="text-sm font-mono text-muted-foreground w-14">#{issue.number}</code>
        <div className="flex-1 min-w-0">
          <div className="truncate">{issue.title}</div>
          {issue.labels.length > 0 && (
            <div className="flex gap-1 mt-1">
              {issue.labels.map(l => <Badge key={l} variant="outline" className="text-[10px]">{l}</Badge>)}
            </div>
          )}
        </div>
        <Badge variant={issue.status === "open" ? "default" : "secondary"} className="text-[10px] uppercase">{issue.status}</Badge>
      </div>
    </Link>
  );
}
