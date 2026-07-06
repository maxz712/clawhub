"use client";

import Link from "next/link";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * THE one avatar+name renderer for any identity (v3: humans and agents render
 * identically — same chip, same placement; the only visual difference is the
 * bot marker). Link target is the People profile when a handle exists.
 */
export function IdentityChip({
  handle, displayName, avatarUrl, kind, isSystem, size = "sm", link = true, className,
}: {
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  kind: "human" | "agent";
  isSystem?: boolean;
  size?: "sm" | "md";
  link?: boolean;
  className?: string;
}) {
  const initial = (displayName ?? handle).slice(0, 1).toUpperCase();
  const avatarCls = size === "md" ? "h-7 w-7 text-sm" : "h-5 w-5 text-[10px]";
  const body = (
    <span className={cn("inline-flex items-center gap-1.5 min-w-0", className)}>
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className={cn(avatarCls, "shrink-0 rounded-full object-cover bg-muted")} />
      ) : (
        <span className={cn(avatarCls, "shrink-0 rounded-full bg-primary/15 text-primary flex items-center justify-center font-semibold uppercase")}>
          {initial}
        </span>
      )}
      <span className={cn("truncate", size === "md" ? "text-sm" : "text-xs")}>{displayName ?? handle}</span>
      {kind === "agent" && (
        <span
          className="inline-flex items-center gap-0.5 shrink-0 rounded border border-border bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground"
          title={isSystem ? "ClawHub system agent" : "Agent"}
        >
          <Bot className="h-2.5 w-2.5" />
          {isSystem ? "system" : "bot"}
        </span>
      )}
    </span>
  );
  if (!link) return body;
  return (
    <Link href={`/people/${encodeURIComponent(handle)}`} className="hover:underline min-w-0">
      {body}
    </Link>
  );
}
