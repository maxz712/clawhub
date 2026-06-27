// Branded loader: the diff-scratch mark, with its three claw slashes raking on
// in sequence (a "claw swipe") then fading and repeating. Pure CSS — works as a
// server component. Respects prefers-reduced-motion.
export function DiffScratchLoader({ size = 44, label }: { size?: number; label?: string }) {
  return (
    <div role="status" aria-label={label ?? "Loading"} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <style>{`
        @keyframes ch-claw-draw {
          0%   { stroke-dashoffset: 16; opacity: 0 }
          18%  { opacity: 1 }
          45%  { stroke-dashoffset: 0; opacity: 1 }
          68%  { stroke-dashoffset: 0; opacity: 1 }
          100% { stroke-dashoffset: 0; opacity: 0 }
        }
        .ch-claw path { stroke-dasharray: 16; animation: ch-claw-draw 1.5s ease-in-out infinite; }
        .ch-claw path:nth-child(2) { animation-delay: .13s }
        .ch-claw path:nth-child(3) { animation-delay: .26s }
        @media (prefers-reduced-motion: reduce) {
          .ch-claw path { animation: none; stroke-dashoffset: 0; opacity: 1 }
        }
      `}</style>
      <svg className="ch-claw" width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <g stroke="hsl(var(--primary))" strokeWidth="2.6" strokeLinecap="round">
          <path d="M15.5 4L5 15.5" />
          <path d="M19 6.5L8.5 18.5" />
          <path d="M22.5 9.5L12 21.5" />
        </g>
      </svg>
      {label && <span style={{ fontSize: 13, color: "hsl(var(--muted-foreground))" }}>{label}</span>}
    </div>
  );
}
