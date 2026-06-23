"use client";

import { memo, useMemo, useState, type ReactNode } from "react";
import { parseUnifiedDiff, filePath, type DiffLine, type FileDiff } from "@/lib/diff";
import { highlightLine, languageFor } from "@/lib/highlight";
import type { ReviewFocus } from "@/lib/api";
import { ChevronDown, ChevronRight, ChevronUp, Flag } from "lucide-react";

const CONTEXT = 3;

interface FileView {
  file: FileDiff;
  path: string;
  focus: ReviewFocus[];
  flaggedCount: number;
}

function isFlagged(line: DiffLine, focus: ReviewFocus[]): boolean {
  return line.newNo !== null && focus.some(f => line.newNo! >= f.startLine && line.newNo! <= f.endLine);
}

function noteFor(line: DiffLine, focus: ReviewFocus[]): ReviewFocus | null {
  if (line.newNo === null) return null;
  return focus.find(f => f.startLine === line.newNo) ?? null;
}

/**
 * The review surface. Renders a parsed unified diff as per-file cards with
 * old/new line gutters. Review-Focus ranges get a flag gutter, an amber tint,
 * and their note inline above the range. Focused mode shows only flagged
 * regions (±3 lines); everything else collapses behind expanders.
 *
 * Pass `onLineSelect` to make the new-line gutter clickable — it fires
 * `(path, line)` so a parent can start a comment thread anchored to that line
 * without the reviewer typing the path + number by hand.
 *
 * `mode` (when given) makes focused/full a CONTROLLED prop and hides the
 * internal toggle — used by the Change page so the Focused/Full *tabs* are the
 * single source of truth (no redundant in-diff toggle). Omit it and the
 * component keeps its own toggle. `renderLineComments(path, line)` lets the
 * parent render inline review-comment threads anchored under a specific line.
 */
export function DiffReview({ diff, focus, onLineSelect, mode: modeProp, renderLineComments }: {
  diff: string; focus: ReviewFocus[]; onLineSelect?: (path: string, line: number) => void;
  mode?: "focused" | "full"; renderLineComments?: (path: string, line: number) => ReactNode;
}) {
  const views = useMemo<FileView[]>(() => {
    return parseUnifiedDiff(diff).map(file => {
      const path = filePath(file);
      const fileFocus = focus.filter(f => f.path === path);
      const flaggedCount = file.hunks.flatMap(h => h.lines).filter(l => isFlagged(l, fileFocus)).length;
      return { file, path, focus: fileFocus, flaggedCount };
    });
  }, [diff, focus]);

  const totalFlaggedFiles = views.filter(v => v.flaggedCount > 0).length;
  // Controlled when the parent passes `mode` (the Change page drives it from the
  // Focused/Full tabs); otherwise the component owns the toggle itself.
  const [internalMode, setInternalMode] = useState<"focused" | "full">(totalFlaggedFiles > 0 ? "focused" : "full");
  const mode = modeProp ?? internalMode;
  const showToggle = modeProp === undefined;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);

  const additions = views.reduce((n, v) => n + v.file.additions, 0);
  const deletions = views.reduce((n, v) => n + v.file.deletions, 0);
  const anchors = views.filter(v => v.flaggedCount > 0).map(v => `diff-file-${v.path}`);

  function jump(delta: number) {
    if (!anchors.length) return;
    const next = (cursor + delta + anchors.length) % anchors.length;
    setCursor(next);
    document.getElementById(anchors[next])?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleFile(path: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  if (views.length === 0) {
    return <div className="p-6 rounded-lg border bg-card text-sm text-muted-foreground">Empty diff.</div>;
  }

  return (
    <div className="space-y-3">
      {/* Summary + controls */}
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="text-muted-foreground">
          {views.length} file{views.length === 1 ? "" : "s"}
          <span className="text-primary ml-2">+{additions}</span>
          <span className="text-destructive ml-1">−{deletions}</span>
        </span>
        {totalFlaggedFiles > 0 && (
          <span className="inline-flex items-center gap-1 text-amber-400">
            <Flag className="h-3.5 w-3.5" /> {totalFlaggedFiles} file{totalFlaggedFiles === 1 ? "" : "s"} flagged
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {totalFlaggedFiles > 0 && mode === "focused" && (
            <div className="flex items-center rounded-md border overflow-hidden">
              <button onClick={() => jump(-1)} aria-label="Previous flagged file" className="px-2 py-1 hover:bg-accent"><ChevronUp className="h-4 w-4" /></button>
              <button onClick={() => jump(1)} aria-label="Next flagged file" className="px-2 py-1 hover:bg-accent border-l"><ChevronDown className="h-4 w-4" /></button>
            </div>
          )}
          {showToggle && (
            <div className="flex rounded-md border overflow-hidden text-xs font-medium">
              <button onClick={() => setInternalMode("focused")}
                className={`px-3 py-1.5 ${mode === "focused" ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"}`}>
                Focused
              </button>
              <button onClick={() => setInternalMode("full")}
                className={`px-3 py-1.5 border-l ${mode === "full" ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"}`}>
                Full diff
              </button>
            </div>
          )}
        </div>
      </div>

      {mode === "focused" && totalFlaggedFiles === 0 && (
        <div className="p-3 rounded-lg border bg-card text-sm text-muted-foreground">
          Nothing was flagged for review — showing every file. Agents flag lines with <code className="font-mono text-xs">Review-Focus:</code> trailers or <code className="font-mono text-xs">{"// REVIEW:"}</code> comments.
        </div>
      )}

      {views.map(v => (
        <FileCard key={v.path} view={v}
          mode={totalFlaggedFiles === 0 ? "full" : mode}
          forceOpen={expanded.has(v.path)}
          onToggle={() => toggleFile(v.path)}
          onLineSelect={onLineSelect}
          renderLineComments={renderLineComments} />
      ))}
    </div>
  );
}

function FileCard({ view, mode, forceOpen, onToggle, onLineSelect, renderLineComments }: {
  view: FileView; mode: "focused" | "full"; forceOpen: boolean; onToggle: () => void;
  onLineSelect?: (path: string, line: number) => void;
  renderLineComments?: (path: string, line: number) => ReactNode;
}) {
  const { file, path, focus, flaggedCount } = view;
  const status = file.oldPath === null ? "added" : file.newPath === null ? "deleted" : null;
  // In focused mode an unflagged file collapses by default — but we still render
  // a visible "(+N -M, not flagged)" header row so the file is never silently
  // omitted; the reviewer can expand it explicitly.
  const collapsedUnflagged = mode === "focused" && flaggedCount === 0 && !forceOpen;
  const showBody = !collapsedUnflagged;
  const focusedBody = mode === "focused" && flaggedCount > 0 && !forceOpen;

  return (
    <div id={`diff-file-${path}`} className="rounded-lg border bg-card overflow-hidden scroll-mt-4">
      {/* File header */}
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 border-b">
        {showBody ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
        <code className="font-mono text-xs truncate">{path}</code>
        {status && <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${status === "added" ? "text-primary border-primary/30" : "text-destructive border-destructive/30"}`}>{status}</span>}
        {flaggedCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-amber-400 border border-amber-400/30 rounded px-1.5 py-0.5">
            <Flag className="h-3 w-3" /> {focus.length} flag{focus.length === 1 ? "" : "s"}
          </span>
        )}
        {collapsedUnflagged && <span className="text-[10px] text-muted-foreground">not flagged</span>}
        <span className="ml-auto text-xs font-mono shrink-0">
          <span className="text-primary">+{file.additions}</span>{" "}
          <span className="text-destructive">−{file.deletions}</span>
        </span>
      </button>

      {file.binary ? (
        showBody && <div className="px-4 py-3 text-sm text-muted-foreground">Binary file.</div>
      ) : showBody && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {file.hunks.map((hunk, hi) => (
                <HunkRows key={hi} hunk={hunk} focus={focus} focused={focusedBody} lang={languageFor(path)} path={path} onLineSelect={onLineSelect} renderLineComments={renderLineComments} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HunkRows({ hunk, focus, focused, lang, path, onLineSelect, renderLineComments }: {
  hunk: { header: string; lines: DiffLine[] }; focus: ReviewFocus[]; focused: boolean; lang: string | null;
  path: string; onLineSelect?: (path: string, line: number) => void;
  renderLineComments?: (path: string, line: number) => ReactNode;
}) {
  // Per-gap expansion: clicking "⋯ N unflagged lines" reveals only that gap, not
  // the whole file. Each elided segment carries an index into this set.
  const [openGaps, setOpenGaps] = useState<Set<number>>(new Set());
  // In focused mode, keep flagged lines ±CONTEXT; group the rest into gaps.
  // Gaps carry their own lines so a click reveals just that gap's region.
  const segments: Array<{ type: "lines"; lines: DiffLine[] } | { type: "gap"; lines: DiffLine[] }> = [];
  if (!focused) {
    segments.push({ type: "lines", lines: hunk.lines });
  } else {
    const keep = new Set<number>();
    hunk.lines.forEach((l, i) => {
      if (isFlagged(l, focus)) for (let j = Math.max(0, i - CONTEXT); j <= Math.min(hunk.lines.length - 1, i + CONTEXT); j++) keep.add(j);
    });
    if (keep.size === 0) return null;
    let buf: DiffLine[] = [];
    let gapBuf: DiffLine[] = [];
    hunk.lines.forEach((l, i) => {
      if (keep.has(i)) {
        if (gapBuf.length) { segments.push({ type: "gap", lines: gapBuf }); gapBuf = []; }
        buf.push(l);
      } else {
        if (buf.length) { segments.push({ type: "lines", lines: buf }); buf = []; }
        gapBuf.push(l);
      }
    });
    if (buf.length) segments.push({ type: "lines", lines: buf });
    if (gapBuf.length) segments.push({ type: "gap", lines: gapBuf });
  }

  function toggleGap(i: number) {
    setOpenGaps(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  return (
    <>
      {!focused && (
        <tr className="bg-muted/40">
          <td colSpan={3} className="px-3 py-1 text-muted-foreground select-none">@@ {hunk.header}</td>
        </tr>
      )}
      {segments.map((seg, si) =>
        seg.type === "gap" ? (
          openGaps.has(si) ? (
            seg.lines.map((line, li) => <LineRow key={`g-${si}-${li}`} line={line} focus={focus} lang={lang} path={path} onLineSelect={onLineSelect} renderLineComments={renderLineComments} />)
          ) : (
            <tr key={`gap-${si}`}>
              <td colSpan={3} className="p-0">
                <button onClick={() => toggleGap(si)} className="w-full px-3 py-1 text-center text-muted-foreground/70 bg-muted/20 hover:bg-accent hover:text-foreground select-none">
                  ⋯ {seg.lines.length} unflagged line{seg.lines.length === 1 ? "" : "s"}
                </button>
              </td>
            </tr>
          )
        ) : (
          seg.lines.map((line, li) => <LineRow key={`${si}-${li}`} line={line} focus={focus} lang={lang} path={path} onLineSelect={onLineSelect} renderLineComments={renderLineComments} />)
        )
      )}
    </>
  );
}

const LineRow = memo(function LineRow({ line, focus, lang, path, onLineSelect, renderLineComments }: { line: DiffLine; focus: ReviewFocus[]; lang: string | null; path?: string; onLineSelect?: (path: string, line: number) => void; renderLineComments?: (path: string, line: number) => ReactNode }) {
  const flagged = isFlagged(line, focus);
  const note = noteFor(line, focus);
  const html = highlightLine(line.text, lang);
  // Inline review-comment threads anchored to this (path, new-line).
  const comments = renderLineComments && path != null && line.newNo != null ? renderLineComments(path, line.newNo) : null;
  const rowBg =
    flagged ? "bg-amber-500/10"
    : line.kind === "add" ? "bg-primary/10"
    : line.kind === "del" ? "bg-destructive/10"
    : "";
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  const markerColor = line.kind === "add" ? "text-primary" : line.kind === "del" ? "text-destructive" : "text-transparent";
  const selectable = !!onLineSelect && path != null && line.newNo != null;

  return (
    <>
      {note && (
        <tr>
          <td colSpan={3} className="p-0">
            <div className="flex items-start gap-2 px-3 py-1.5 bg-amber-500/15 border-l-2 border-amber-400 text-amber-300">
              <Flag className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span className="font-sans">{note.note ?? `Flagged for review (lines ${note.startLine}–${note.endLine})`}</span>
            </div>
          </td>
        </tr>
      )}
      <tr className={rowBg}>
        <td className={`w-10 min-w-10 pr-2 text-right select-none text-muted-foreground/50 align-top ${flagged ? "border-l-2 border-amber-400" : "border-l-2 border-transparent"}`}>
          {line.oldNo ?? ""}
        </td>
        <td
          className={`w-10 min-w-10 pr-2 text-right select-none text-muted-foreground/50 align-top ${selectable ? "cursor-pointer hover:text-primary hover:underline" : ""}`}
          onClick={selectable ? () => onLineSelect!(path!, line.newNo!) : undefined}
          title={selectable ? "Comment on this line" : undefined}
        >
          {line.newNo ?? ""}
        </td>
        <td className="pr-4 align-top whitespace-pre">
          <span className={`inline-block w-4 select-none ${markerColor}`}>{marker}</span>
          {html !== null
            ? <span dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }} />
            : (line.text || " ")}
        </td>
      </tr>
      {comments && (
        <tr>
          <td colSpan={3} className="p-0 border-l-2 border-primary/40 bg-muted/10">
            <div className="px-3 py-2 font-sans whitespace-normal">{comments}</div>
          </td>
        </tr>
      )}
    </>
  );
});
