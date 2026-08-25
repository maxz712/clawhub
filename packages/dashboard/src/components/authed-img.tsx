"use client";

import { useEffect, useState } from "react";
import { isApiHostedBlob } from "@/lib/blob-origin";

// A repo's evidence/attachment blobs are served behind repo-read auth, so a
// plain <img src> (which can't send a Bearer token) 401s on a private repo.
// AuthedImg fetches api-hosted blobs WITH the token and renders the bytes via an
// object URL; external URLs render directly. Shared by EvidencePanel (change
// screenshots) and the Markdown renderer (issue/comment attachments, #12).
// isApiHostedBlob is an ORIGIN check (lib/blob-origin) — see #167 for why a
// substring test attaches the viewer's credential to attacker-chosen origins.
export { isApiHostedBlob };

export function AuthedImg({ url, alt, full = false, className }: { url: string; alt: string; full?: boolean; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const apiHosted = isApiHostedBlob(url);
  useEffect(() => {
    if (!apiHosted) { setSrc(url); return; }
    let live = true; let obj: string | null = null;
    const token = typeof window !== "undefined" ? localStorage.getItem("clawhub_token") : null;
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(b => { if (!live) return; obj = URL.createObjectURL(b); setSrc(obj); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (obj) URL.revokeObjectURL(obj); };
  }, [url, apiHosted]);
  if (failed) return <a href={url} target="_blank" rel="noreferrer" className="text-xs text-primary underline break-all">{url}</a>;
  // Inline-block (a <span>, not a <div>) so it's valid inside a markdown <p>.
  if (!src) return <span className="inline-block h-24 w-40 max-w-full animate-pulse rounded border border-border bg-muted/30 align-middle" />;
  const cls = className ?? `rounded border border-border max-h-64${full ? " w-full object-contain" : ""}`;
  // For api-hosted blobs the object URL isn't externally linkable, so only wrap
  // external URLs in an anchor.
  const img = <img src={src} alt={alt} className={cls} />;
  return apiHosted ? img : <a href={url} target="_blank" rel="noreferrer">{img}</a>;
}
