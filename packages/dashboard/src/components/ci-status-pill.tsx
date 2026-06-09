import type { CiStatus } from "@/lib/api";

const STYLES: Record<CiStatus, string> = {
  pending: "bg-muted text-muted-foreground border-border",
  running: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  success: "bg-primary/15 text-primary border-primary/30",
  failure: "bg-destructive/15 text-destructive border-destructive/30",
  skipped: "bg-muted text-muted-foreground border-border",
};

export function CiStatusPill({ status }: { status: CiStatus }) {
  if (status === "skipped") return null; // no CI configured — not worth a pill
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-mono uppercase ${STYLES[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === "running" ? "animate-pulse" : ""} ${
        status === "pending" ? "bg-muted-foreground"
          : status === "running" ? "bg-blue-400"
          : status === "success" ? "bg-primary"
          : "bg-destructive"
      }`} />
      ci: {status}
    </span>
  );
}
