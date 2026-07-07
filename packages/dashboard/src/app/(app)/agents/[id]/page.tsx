"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

/**
 * v4: identities live in ONE place — /people/[handle] is THE identity page for
 * humans AND agents (a governed agent shows its full management surface there
 * via AgentAdminPanel). This route is kept only as a client redirect so old
 * /agents/<id> links (and ?tab= deep-links, which are preserved) keep working.
 */
export default function AgentDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  useEffect(() => {
    let live = true;
    api.listAgents()
      .then(r => {
        if (!live) return;
        const agent = r.agents.find(a => a.id === id);
        if (!agent) { router.replace("/agents"); return; }
        // Carry ?tab= etc. along — AgentAdminPanel reads it on the profile page.
        const search = typeof window !== "undefined" ? window.location.search : "";
        router.replace(`/people/${encodeURIComponent(agent.name)}${search}`);
      })
      .catch(() => { if (live) router.replace("/agents"); });
    return () => { live = false; };
  }, [id, router]);

  return <div className="text-muted-foreground">Redirecting to the agent&apos;s profile…</div>;
}
