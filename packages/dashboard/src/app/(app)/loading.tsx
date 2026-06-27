import { DiffScratchLoader } from "@/components/diff-scratch-loader";

// Route-level loading UI for the authenticated app — shows the branded
// claw-swipe while a page's data resolves.
export default function Loading() {
  return (
    <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <DiffScratchLoader size={48} label="Loading…" />
    </div>
  );
}
