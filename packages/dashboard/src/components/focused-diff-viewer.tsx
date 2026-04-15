"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Mode = "focused" | "full";

export function FocusedDiffViewer({
  diff, mode, onModeChange,
}: {
  diff: string;
  mode: Mode;
  onModeChange: (m: Mode) => void;
}) {
  return (
    <div className="space-y-3">
      <Tabs value={mode} onValueChange={v => onModeChange(v as Mode)}>
        <TabsList>
          <TabsTrigger value="focused">Focused</TabsTrigger>
          <TabsTrigger value="full">Full diff</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="rounded border bg-card">
        {diff.trim() === "" ? (
          <div className="p-6 text-sm text-muted-foreground">
            {mode === "focused" ? "No lines flagged for review. Switch to full diff to see everything." : "(empty diff)"}
          </div>
        ) : (
          <pre className="p-4 text-xs font-mono leading-relaxed overflow-auto">
            {diff.split("\n").map((line, i) => {
              const color =
                line.startsWith("+++") || line.startsWith("---") ? "text-muted-foreground"
                : line.startsWith("+") ? "text-primary"
                : line.startsWith("-") ? "text-destructive"
                : line.startsWith("@@") ? "text-blue-400"
                : line.startsWith("### ") ? "text-foreground font-semibold"
                : "text-muted-foreground";
              return <div key={i} className={color}>{line || "\u00a0"}</div>;
            })}
          </pre>
        )}
      </div>
    </div>
  );
}
