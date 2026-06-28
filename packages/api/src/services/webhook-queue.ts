import { createHmac } from "node:crypto";
import { and, desc, eq, lte, or, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { webhookDeliveries, webhooks, type WebhookDelivery } from "../models/schema.js";
import type { EventBus } from "./events.js";
import { log } from "./logger.js";
import { assertPublicHttpHost } from "./url-guard.js";

const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000, 14_400_000];

export async function enqueue(db: DB, webhookId: string, payload: Record<string, unknown>): Promise<WebhookDelivery> {
  const [row] = await db.insert(webhookDeliveries).values({
    webhookId,
    payload: payload as unknown as Record<string, unknown>,
    nextAttemptAt: new Date(),
  }).returning();
  return row;
}

export async function listDeliveries(db: DB, webhookId: string, opts: { status?: string; limit?: number } = {}): Promise<WebhookDelivery[]> {
  const limit = opts.limit ?? 100;
  const conds = [eq(webhookDeliveries.webhookId, webhookId)];
  if (opts.status) conds.push(eq(webhookDeliveries.status, opts.status));
  return db.select().from(webhookDeliveries).where(and(...conds)).orderBy(desc(webhookDeliveries.createdAt)).limit(limit);
}

// Scope the replay to the OWNING webhook: the caller is authorized against that
// webhook's repo, so a delivery id alone (no webhookId constraint) would let a
// writer on one repo re-enqueue a delivery belonging to another repo's webhook.
// Returns the number of rows reset (0 = the delivery isn't this webhook's).
export async function replayDelivery(db: DB, webhookId: string, id: string): Promise<number> {
  const updated = await db.update(webhookDeliveries)
    .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null, finishedAt: null })
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.webhookId, webhookId)))
    .returning({ id: webhookDeliveries.id });
  return updated.length;
}

export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;

  private draining = false;

  constructor(private db: DB, private events: EventBus, private pollMs = Number(process.env.CLAWHUB_WEBHOOK_POLL_MS ?? 5_000)) {}

  start(): void {
    if (this.timer) return;
    this.events.onEvent(async e => {
      if (!e.repoId) return;
      const hooks = await this.db.select().from(webhooks).where(and(eq(webhooks.repoId, e.repoId), eq(webhooks.enabled, true)));
      for (const h of hooks) {
        const subs = h.events as string[];
        if (subs.length && !subs.includes(e.type) && !subs.includes("*")) continue;
        await enqueue(this.db, h.id, { type: e.type, repoId: e.repoId, changeId: e.changeId, payload: e.payload });
      }
      // Deliver immediately rather than waiting out the poll interval. The
      // interval is only the retry/backoff sweep.
      if (hooks.length) this.tick().catch(err => log("warn", "webhook_tick_failed", { err: String(err) }));
    });
    this.timer = setInterval(() => this.tick().catch(err => log("warn", "webhook_tick_failed", { err: String(err) })), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.draining) return; // poll + event-wake can overlap
    this.draining = true;
    try { await this.drainDue(); } finally { this.draining = false; }
  }

  private async drainDue(): Promise<void> {
    const due = await this.db.select().from(webhookDeliveries)
      .where(and(
        or(eq(webhookDeliveries.status, "pending"), eq(webhookDeliveries.status, "retrying"))!,
        lte(webhookDeliveries.nextAttemptAt, new Date()),
      ))
      .limit(50);

    for (const d of due) {
      const hook = (await this.db.select().from(webhooks).where(eq(webhooks.id, d.webhookId)).limit(1))[0];
      if (!hook) { await this.fail(d, "webhook_gone", true); continue; }

      // SSRF guard: refuse webhook URLs whose host resolves to a private/internal target.
      const blocked = await assertPublicHttpHost(hook.url);
      if (blocked) { await this.fail(d, "delivery_failed", false); continue; }

      const body = JSON.stringify(d.payload);
      const sig = createHmac("sha256", hook.secret).update(body).digest("hex");
      try {
        const res = await fetch(hook.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-clawhub-signature": `sha256=${sig}`, "x-clawhub-delivery": d.id },
          body,
          redirect: "manual", // a public host must not 3xx-redirect us to an internal target
          signal: AbortSignal.timeout(10_000),
        });
        // Treat any redirect (incl. opaqueredirect) as a failure — see redirect:"manual".
        if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") throw new Error("redirect_blocked");
        if (!res.ok) throw new Error(`http_${res.status}`);
        await this.db.update(webhookDeliveries).set({ status: "delivered", finishedAt: new Date(), attempts: sql`${webhookDeliveries.attempts} + 1` }).where(eq(webhookDeliveries.id, d.id));
      } catch (e) {
        // Normalize errors so a stored lastError can't be used as an internal port-scanner oracle.
        const msg = (e as Error).message;
        await this.fail(d, msg === "redirect_blocked" || /^http_\d+$/.test(msg) ? msg : "delivery_failed", false);
      }
    }

    // Move terminal failures to dead-letter status.
  }

  private async fail(d: WebhookDelivery, err: string, terminal: boolean): Promise<void> {
    const attempts = d.attempts + 1;
    const dead = terminal || attempts >= MAX_ATTEMPTS;
    const next = new Date(Date.now() + (BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]));
    await this.db.update(webhookDeliveries).set({
      attempts,
      status: dead ? "dead" : "retrying",
      lastError: err,
      nextAttemptAt: next,
      finishedAt: dead ? new Date() : null,
    }).where(eq(webhookDeliveries.id, d.id));
  }
}
