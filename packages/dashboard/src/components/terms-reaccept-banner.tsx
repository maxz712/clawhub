"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

// Versioned re-acceptance banner (M3 legal). When the platform bumps its Terms
// version, /me reports termsCurrent:false and this asks the user to re-accept.
// Silent + dismissed once accepted; never blocks the app.
export function TermsReacceptBanner() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.getMe().then(u => { if (u.termsCurrent === false) setShow(true); }).catch(() => {});
  }, []);
  if (!show) return null;
  async function accept() {
    setBusy(true);
    try { await api.acceptTerms(); setShow(false); } catch { /* leave the banner up */ } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
      <span>Our <Link href="/terms" className="underline" target="_blank">Terms</Link> and <Link href="/privacy" className="underline" target="_blank">Privacy Policy</Link> were updated.</span>
      <button onClick={accept} disabled={busy} className="ml-auto rounded bg-amber-400/20 px-3 py-1 text-xs font-medium hover:bg-amber-400/30 disabled:opacity-50">
        {busy ? "Saving…" : "I accept"}
      </button>
    </div>
  );
}
