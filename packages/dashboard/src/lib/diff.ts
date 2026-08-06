// Unified-diff parser for the review UI. Turns `git diff` output into
// files → hunks → lines with old/new line numbers, so the viewer can render
// gutters, highlight Review-Focus ranges, and collapse unflagged context.

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null; // null for adds
  newNo: number | null; // null for dels
  text: string;         // without the +/-/space prefix
}

export interface DiffHunk {
  header: string;       // the bit after @@ ... @@, usually the enclosing symbol
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string | null; // null when created
  newPath: string | null; // null when deleted
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary: boolean;
  /** The file moved: `oldPath` and `newPath` differ (git `rename`/`copy` headers). */
  renamed: boolean;
}

/** Display path: the new path, falling back to the old one for deletions. */
export function filePath(f: FileDiff): string {
  return f.newPath ?? f.oldPath ?? "(unknown)";
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { oldPath: null, newPath: null, hunks: [], additions: 0, deletions: 0, binary: false, renamed: false };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    // A rename/copy carries its paths in `rename from`/`rename to` headers, and a
    // 100%-similarity rename emits NO `---`/`+++` pair at all — so without this
    // both paths stayed null and the file rendered as "(unknown)", badged ADDED.
    // A moved migration was invisible to the reviewer (#128).
    // Fixed-width prefixes, not indexOf — a path may itself contain " from ".
    // These headers carry the bare path (no a// b/ prefix).
    if (line.startsWith("rename from ")) { file.oldPath = line.slice(12); file.renamed = true; continue; }
    if (line.startsWith("copy from ")) { file.oldPath = line.slice(10); file.renamed = true; continue; }
    if (line.startsWith("rename to ")) { file.newPath = line.slice(10); file.renamed = true; continue; }
    if (line.startsWith("copy to ")) { file.newPath = line.slice(8); file.renamed = true; continue; }

    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      file.oldPath = p === "/dev/null" ? null : p.replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file.newPath = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("Binary files ")) {
      file.binary = true;
      continue;
    }

    const m = line.match(HUNK_RE);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: m[3] ?? "", lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // file metadata lines (index, mode, rename)

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
      file.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
      file.deletions++;
    } else if (line.startsWith(" ") || line === "") {
      hunk.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    }
    // "\ No newline at end of file" and anything else: ignore.
  }

  return files;
}
