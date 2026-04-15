"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";

export default function IssuesIndexPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Issues</h1>
        <p className="text-muted-foreground mt-1">Issues live per repo. Pick a repo to see its queue.</p>
      </div>
      <Card>
        <CardContent className="pt-6 text-sm">
          Go to <Link href="/repos" className="text-primary hover:underline">your repos</Link> and open one to see its issues.
        </CardContent>
      </Card>
    </div>
  );
}
