"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Copyable single-value block. Shared across onboarding, repo clone, token
 * issuance, webhook secrets, and package examples so every "save this now"
 * surface gets a one-click copy affordance instead of a bare <code>.
 *
 * Pass `display` to show a masked/short form while copying the full `value`.
 */
export function CopyBlock({ value, label, display }: { value: string; label?: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group/copy">
      {label && <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">{label}</div>}
      <code className="block p-2.5 pr-10 rounded border border-border bg-muted font-mono text-xs break-all leading-relaxed">{display ?? value}</code>
      <button
        type="button"
        aria-label="Copy"
        title="Copy"
        onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute top-1.5 right-1.5 inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-background text-muted-foreground hover:text-foreground transition-colors"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
