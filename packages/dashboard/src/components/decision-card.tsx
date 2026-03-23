"use client";

import { Card, CardContent } from "@/components/ui/card";

export interface DecisionData {
  title: string;
  reviewer_assessment?: string;
  file_path?: string;
  file_lines?: string;
  code_snippet?: string;
}

export function DecisionCard({ decision }: { decision: DecisionData }) {
  return (
    <Card className="bg-card border-border border-l-4 border-l-blue-500">
      <CardContent className="p-4 space-y-3">
        <p className="text-sm font-medium">{decision.title}</p>

        {decision.reviewer_assessment && (
          <p className="text-sm text-muted-foreground italic">
            &quot;{decision.reviewer_assessment}&quot;
          </p>
        )}

        {decision.file_path && (
          <div className="text-xs font-mono text-blue-400">
            {decision.file_path}
            {decision.file_lines && `:${decision.file_lines}`}
          </div>
        )}

        {decision.code_snippet && (
          <pre className="text-xs font-mono bg-muted/30 rounded-md p-3 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap">
            {decision.code_snippet}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
