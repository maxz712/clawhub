"use client";

import Link from "next/link";
import type { WorkflowDispatch } from "@/lib/api";
import { Zap } from "lucide-react";

// v3 P4 — thread slash commands. A Change/Issue comment that LEADS with one of
// these dispatches the matching workflow server-side (services/slash-commands.ts,
// same expansion as scheduled runs). This is the composer-side affordance: a
// hint row while drafting, and a dispatch confirmation after the POST.

export const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/dev", desc: "build the top issue end-to-end" },
  { cmd: "/review", desc: "review open changes" },
  { cmd: "/verify", desc: "verify this change in a real browser" },
  { cmd: "/test", desc: "alias of /verify" },
  { cmd: "/scout", desc: "file one high-value issue" },
  { cmd: "/triage", desc: "label, prioritize + route issues" },
  { cmd: "/loop", desc: "run the full improvement loop" },
];

const COMMAND_RE = /^\/(dev|review|verify|test|check|scout|triage|loop)\b/i;

/** True when the draft leads with a KNOWN slash command (would dispatch). */
export function isSlashCommandDraft(draft: string): boolean {
  return COMMAND_RE.test(draft.trimStart());
}

/** The hint row shown while a draft starts with "/" — lists what's available. */
export function SlashCommandHint({ draft }: { draft: string }) {
  if (!draft.trimStart().startsWith("/")) return null;
  return (
    <div className="rounded border border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1 font-medium text-foreground">
        <Zap className="h-3 w-3 text-primary" /> Workflow commands
      </span>{" "}
      — a comment starting with one dispatches an agent:
      <span className="block mt-1 space-x-2">
        {SLASH_COMMANDS.map(c => (
          <span key={c.cmd} className="inline-block whitespace-nowrap">
            <code className="font-mono text-foreground">{c.cmd}</code>{" "}
            <span className="text-muted-foreground/80">{c.desc}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

/** Inline confirmation after a comment POST returned a workflowRun result. */
export function WorkflowDispatchNotice({ result, runsHref }: { result: WorkflowDispatch; runsHref: string }) {
  if (result.dispatched) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-primary">
        <Zap className="h-3.5 w-3.5" />
        <span>
          Dispatched{result.standingAgentName ? <> to <code className="font-mono">@{result.standingAgentName}</code></> : null} —{" "}
          <Link href={runsHref} className="underline underline-offset-2">view runs</Link>
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1.5 text-xs text-amber-400">
      <Zap className="h-3.5 w-3.5" />
      <span>Not dispatched — {result.note ?? "no agent picked it up"}</span>
    </p>
  );
}
