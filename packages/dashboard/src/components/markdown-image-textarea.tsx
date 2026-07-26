"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { Textarea } from "@/components/ui/textarea";
import { ImagePlus, Loader2 } from "lucide-react";

// A Textarea that accepts image attachments (#12): click "Attach image", paste
// an image from the clipboard, or drag-drop a file. Each upload goes to the
// repo's issue-attachment store and its returned URL is spliced into the body as
// `![name](url)` markdown at the cursor — so a bug reporter can drop a screenshot
// straight in, instead of hosting it elsewhere and pasting a URL.
//
// Controlled: parent owns `value`/`onChange`, exactly like a bare Textarea, so
// this drops into the issue create/edit/comment composers unchanged.
export function MarkdownImageTextarea({
  ns, repo, value, onChange, className, rows, placeholder, disabled,
}: {
  ns: string;
  repo: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Splice `snippet` in at the cursor (or append), keeping the caret sensible.
  function insertAtCursor(snippet: string) {
    const el = ref.current;
    if (!el) { onChange(value ? `${value}\n${snippet}\n` : `${snippet}\n`); return; }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + snippet + value.slice(end);
    onChange(next);
    // Restore focus + place the caret just after the inserted snippet.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      try { el.setSelectionRange(pos, pos); } catch { /* detached */ }
    });
  }

  async function uploadFiles(files: File[]) {
    const images = files.filter(f => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setUploading(true); setError(null);
    try {
      for (const file of images) {
        const { url } = await api.uploadIssueAttachment(ns, repo, file);
        const alt = (file.name || "screenshot").replace(/[[\]()]/g, "").slice(0, 60) || "screenshot";
        insertAtCursor(`![${alt}](${url})`);
      }
    } catch (e) {
      setError((e as Error).message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div
        onDragOver={e => { if (!disabled) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          if (disabled) return;
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.some(f => f.type.startsWith("image/"))) { e.preventDefault(); setDragOver(false); void uploadFiles(files); }
          else setDragOver(false);
        }}
        className={dragOver ? "rounded-lg ring-2 ring-primary" : undefined}
      >
        <Textarea
          ref={ref}
          value={value}
          onChange={e => onChange(e.target.value)}
          onPaste={e => {
            if (disabled) return;
            const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith("image/"));
            if (files.length) { e.preventDefault(); void uploadFiles(files); }
          }}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          className={className}
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void uploadFiles(files); }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || uploading}
          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImagePlus className="h-3 w-3" />}
          {uploading ? "Uploading…" : "Attach image"}
        </button>
        <span>or paste / drop a screenshot. Markdown + GFM supported.</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
