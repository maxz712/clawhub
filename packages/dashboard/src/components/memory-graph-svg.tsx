"use client";

import { useState } from "react";
import type { Memory, MemoryEdge } from "@/lib/api";
import { Brain } from "lucide-react";

// Node fill by memory kind (hex, since SVG can't take Tailwind classes). Mirrors the
// list view's kind palette (globals.css tokens).
const KIND_FILL: Record<string, string> = {
  decision: "#a78bfa", convention: "#00e5a0", failure: "#ff5f5f", expertise: "#5f9eff", episode: "#8888a0",
};
const CODE_FILL = "#3b3b46";

interface GNode { key: string; type: "memory" | "code"; label: string; title: string; kind?: string }
interface GEdge { src: string; dst: string; relation: string; origin: string }

function trunc(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function basename(p: string) { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }

/**
 * A deterministic circular node-link view of the repo memory graph: memories are
 * colored circles (by kind), code files are squares, edges are lines (solid =
 * agent-authored, dashed = ClawHub-derived). Hovering a node highlights its edges.
 * No physics — layout is a stable ring so it never jitters. See docs/memory.md.
 */
export function MemoryGraphSvg({ nodes, edges }: { nodes: Memory[]; edges: MemoryEdge[] }) {
  const [hover, setHover] = useState<string | null>(null);

  const memKey = (id: string) => `m:${id}`;
  const gnodes: GNode[] = nodes.map(m => ({ key: memKey(m.id), type: "memory", kind: m.kind, label: trunc(m.title, 24), title: `[${m.kind}] ${m.title}` }));
  const codePaths = new Set<string>();
  for (const e of edges) if (e.dstKind === "code" && e.dstPath) codePaths.add(e.dstPath);
  for (const p of codePaths) gnodes.push({ key: `c:${p}`, type: "code", label: trunc(basename(p), 24), title: p });

  const keys = new Set(gnodes.map(n => n.key));
  const gedges: GEdge[] = [];
  for (const e of edges) {
    const src = memKey(e.srcMemoryId);
    const dst = e.dstKind === "code" ? (e.dstPath ? `c:${e.dstPath}` : null) : (e.dstMemoryId ? memKey(e.dstMemoryId) : null);
    if (dst && keys.has(src) && keys.has(dst)) gedges.push({ src, dst, relation: e.relation, origin: e.origin });
  }

  // Large graphs: drop isolated nodes so the ring stays readable.
  const inEdge = new Set<string>();
  for (const e of gedges) { inEdge.add(e.src); inEdge.add(e.dst); }
  const shown = gnodes.length > 70 ? gnodes.filter(n => inEdge.has(n.key)) : gnodes;
  const shownKeys = new Set(shown.map(n => n.key));
  const drawEdges = gedges.filter(e => shownKeys.has(e.src) && shownKeys.has(e.dst));

  if (!shown.length) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
        <Brain className="h-8 w-8 mx-auto mb-2 opacity-40" />
        <div className="text-sm">No memory graph yet. Edges form as agents author <code className="font-mono">about</code>/<code className="font-mono">relates_to</code> links, or a reflect run wires conventions to the code they govern.</div>
      </div>
    );
  }

  const W = 820, H = 560, cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - 120;
  const N = shown.length;
  const pos = new Map<string, { x: number; y: number }>();
  shown.forEach((n, i) => {
    const a = (2 * Math.PI * i) / N - Math.PI / 2;
    pos.set(n.key, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  });

  const touches = (key: string) => !hover || key === hover || drawEdges.some(e => (e.src === hover && e.dst === key) || (e.dst === hover && e.src === key));

  return (
    <div className="rounded-lg border bg-card p-3 overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 640 }} role="img" aria-label="Memory graph">
        {drawEdges.map((e, i) => {
          const a = pos.get(e.src)!, b = pos.get(e.dst)!;
          const active = !hover || e.src === hover || e.dst === hover;
          return (
            <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={e.origin === "derived" ? "#4a4a55" : "#6b7280"}
              strokeWidth={active ? 1.5 : 0.6} strokeOpacity={active ? 0.85 : 0.12}
              strokeDasharray={e.origin === "derived" ? "4 3" : undefined}>
              <title>{`${e.relation} (${e.origin})`}</title>
            </line>
          );
        })}
        {shown.map(n => {
          const p = pos.get(n.key)!;
          const dim = hover ? !touches(n.key) : false;
          const fill = n.type === "code" ? CODE_FILL : (KIND_FILL[n.kind ?? ""] ?? "#8888a0");
          const anchor = p.x < cx - 8 ? "end" : p.x > cx + 8 ? "start" : "middle";
          const lx = p.x + (anchor === "end" ? -11 : anchor === "start" ? 11 : 0);
          return (
            <g key={n.key} opacity={dim ? 0.2 : 1} onMouseEnter={() => setHover(n.key)} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }}>
              {n.type === "code"
                ? <rect x={p.x - 5} y={p.y - 5} width={10} height={10} fill={fill} stroke="#2a2a33" />
                : <circle cx={p.x} cy={p.y} r={7} fill={fill} stroke="#0a0a0c" strokeWidth={1.5} />}
              <text x={lx} y={p.y + 3} textAnchor={anchor} fontSize={10} fill="#c7c7d1" className="font-mono">{n.label}</text>
              <title>{n.title}</title>
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap px-1 pt-2 text-xs text-muted-foreground">
        {Object.entries(KIND_FILL).map(([k, c]) => (
          <span key={k} className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />{k}</span>
        ))}
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5" style={{ background: CODE_FILL, border: "1px solid #2a2a33" }} />code file</span>
        <span className="inline-flex items-center gap-1"><svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#6b7280" strokeWidth="1.5" /></svg>authored</span>
        <span className="inline-flex items-center gap-1"><svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#4a4a55" strokeWidth="1.5" strokeDasharray="4 3" /></svg>derived</span>
        <span className="ml-auto">{shown.filter(n => n.type === "memory").length} memories · {codePaths.size} files · {drawEdges.length} edges</span>
      </div>
    </div>
  );
}
