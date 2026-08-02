import { describe, it, expect, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { emailOutbox } from "../src/models/schema.js";
import { OutboxWorker, type Mailer } from "../src/services/mailer.js";

// Outbox durability (#115): transient send failures retry with backoff instead
// of terminally dropping the email, and concurrent drainers (multiple API
// replicas) never double-send a row thanks to the CAS nextAttemptAt lease —
// the same shape webhook-queue.ts uses (#79).
const S = Date.now();
const addr = (tag: string) => `outbox-${S}-${tag}@test.local`;

class ScriptedMailer implements Mailer {
  sent: string[] = [];
  calls = 0;
  constructor(private opts: { failFirst?: number; alwaysFail?: boolean; delayMs?: number } = {}) {}
  async send(to: string): Promise<void> {
    this.calls++;
    if (this.opts.delayMs) await new Promise(r => setTimeout(r, this.opts.delayMs));
    if (this.opts.alwaysFail) throw new Error("smtp_always_down");
    if ((this.opts.failFirst ?? 0) >= this.calls) throw new Error("resend_429:rate_limited");
    this.sent.push(to);
  }
}

const insertRow = async (tag: string) => {
  const [row] = await db.insert(emailOutbox).values({
    toEmail: addr(tag), subject: `outbox test ${tag}`, body: "<p>hi</p>",
  }).returning();
  return row;
};
const rowById = async (id: string) => (await db.select().from(emailOutbox).where(eq(emailOutbox.id, id)))[0];
const forceDue = (id: string) =>
  db.update(emailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(emailOutbox.id, id));

describe.skipIf(!hasTestDb)("email outbox durability", () => {
  afterAll(async () => {
    await db.delete(emailOutbox).where(like(emailOutbox.toEmail, `outbox-${S}-%`));
  });

  it("retries a transient failure and delivers exactly once (not terminally failed)", async () => {
    const row = await insertRow("retry");
    const mailer = new ScriptedMailer({ failFirst: 1 });
    const worker = new OutboxWorker(db, mailer);

    await worker.drain();
    let r = await rowById(row.id);
    expect(r.status).toBe("retrying"); // NOT the old terminal "failed"
    expect(r.attempts).toBe(1);
    expect(r.error).toContain("resend_429");
    expect(r.nextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // backoff scheduled
    expect(mailer.sent).toEqual([]);

    await forceDue(row.id);
    await worker.drain();
    r = await rowById(row.id);
    expect(r.status).toBe("sent");
    expect(r.sentAt).not.toBeNull();
    expect(r.error).toBeNull();
    expect(mailer.sent).toEqual([addr("retry")]);
  });

  it("two concurrent drainers deliver each row exactly once (claim is exclusive)", async () => {
    const rows = await Promise.all(["c1", "c2", "c3", "c4", "c5"].map(insertRow));
    const m1 = new ScriptedMailer({ delayMs: 25 });
    const m2 = new ScriptedMailer({ delayMs: 25 });
    await Promise.all([new OutboxWorker(db, m1).drain(), new OutboxWorker(db, m2).drain()]);

    const delivered = [...m1.sent, ...m2.sent].filter(to => to.startsWith(`outbox-${S}-c`));
    expect(delivered.sort()).toEqual(rows.map(r => r.toEmail).sort()); // each exactly once, none dropped
    for (const row of rows) expect((await rowById(row.id)).status).toBe("sent");
  });

  it("lands in terminal failed only after the attempt cap, then is never re-selected", async () => {
    const row = await insertRow("dead");
    const mailer = new ScriptedMailer({ alwaysFail: true });
    const worker = new OutboxWorker(db, mailer);

    for (let i = 1; i <= 6; i++) {
      await forceDue(row.id);
      await worker.drain();
      const r = await rowById(row.id);
      expect(r.attempts).toBe(i);
      expect(r.status).toBe(i < 6 ? "retrying" : "failed");
    }
    const r = await rowById(row.id);
    expect(r.error).toContain("smtp_always_down"); // terminal outcome stays observable

    await forceDue(row.id);
    await worker.drain();
    expect(mailer.calls).toBe(6); // failed is terminal: no further sends
  });
});
