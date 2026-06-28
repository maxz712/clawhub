import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { webhooks } from "../models/schema.js";
import type { ClawHubEvent, EventBus } from "./events.js";
import { assertPublicHttpHost } from "./url-guard.js";

export function wireWebhookDispatch(db: DB, events: EventBus): void {
  events.onEvent(e => { void dispatchForEvent(db, e); });
}

async function dispatchForEvent(db: DB, e: ClawHubEvent): Promise<void> {
  if (!e.repoId) return;
  const hooks = await db.select().from(webhooks).where(eq(webhooks.repoId, e.repoId));
  for (const h of hooks) {
    if (!h.enabled) continue;
    const subs = (h.events as string[]) ?? [];
    if (subs.length && !subs.includes(e.type)) continue;
    void deliver(h.url, h.secret, e).catch(() => { /* log-only in v3 */ });
  }
}

async function deliver(url: string, secret: string, body: ClawHubEvent): Promise<void> {
  // SSRF guard: refuse webhook URLs whose host resolves to a private/internal target.
  if (await assertPublicHttpHost(url)) return;
  const payload = JSON.stringify(body);
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawhub-event": body.type,
      "x-clawhub-signature": `sha256=${signature}`,
    },
    body: payload,
    redirect: "manual", // a public host must not 3xx-redirect us to an internal target
  });
}
