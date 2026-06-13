import type { ReviewBasis } from "@/lib/api";
import { Eye, Code2, ShieldCheck } from "lucide-react";

const META: Record<ReviewBasis, { label: string; className: string; Icon: typeof Eye }> = {
  behavior: { label: "verified behavior", className: "bg-blue-500/15 text-blue-400 border-blue-500/30", Icon: Eye },
  code: { label: "reviewed code", className: "bg-primary/15 text-primary border-primary/30", Icon: Code2 },
  both: { label: "both", className: "bg-purple-500/15 text-purple-400 border-purple-500/30", Icon: ShieldCheck },
};

/** Small chip on a review row stating what the verdict rests on. */
export function ReviewBasisChip({ basis }: { basis: ReviewBasis }) {
  const m = META[basis];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${m.className}`}>
      <m.Icon className="h-3 w-3" />
      {m.label}
    </span>
  );
}
