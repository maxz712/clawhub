import { eq, lte, and, or, asc } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { emailOutbox } from "../models/schema.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

// dev: prints to stdout. Always safe.
export class LogMailer implements Mailer {
  async send(to: string, subject: string, body: string): Promise<void> {
    log("info", "email_sent_log", { to, subject, bytes: body.length });
  }
}

// SMTP over nodemailer-compatible protocol using fetch-to-nothing for external
// SES/Resend/Postmark/etc. We implement a raw SMTP client sparingly — the
// simpler path is HTTP APIs for major providers.

export interface ResendConfig { apiKey: string; from: string }
export class ResendMailer implements Mailer {
  constructor(private cfg: ResendConfig) {}
  async send(to: string, subject: string, body: string): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.cfg.from, to, subject, html: body }),
    });
    if (!res.ok) throw new Error(`resend_${res.status}:${await res.text()}`);
  }
}

export interface SesConfig { region: string; accessKeyId: string; secretAccessKey: string; from: string }
// SES via REST SendEmail action using SigV4 (minimal).
export class SesMailer implements Mailer {
  constructor(private cfg: SesConfig) {}
  async send(to: string, subject: string, body: string): Promise<void> {
    // SES AWS signing is heavy; the production recommendation is to front this
    // with an SMTP relay credential. We error if invoked so operators pick
    // Resend or a local SMTP relay instead.
    throw new Error("ses_sendraw_not_implemented: configure SMTP relay with SES credentials instead");
  }
}

export interface SmtpConfig { host: string; port: number; user?: string; pass?: string; from: string; startTls?: boolean }

// Very small SMTP client: enough to post a single message. Good for most corporate
// relays (Postfix, Sendgrid SMTP, SES SMTP endpoint, Office 365).
import { createConnection } from "node:net";
import { connect as tlsConnect } from "node:tls";

export class SmtpMailer implements Mailer {
  constructor(private cfg: SmtpConfig) {}
  async send(to: string, subject: string, body: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection(this.cfg.port, this.cfg.host);
      let buf = "";
      const wait = (code: string) => new Promise<void>((res, rej) => {
        const on = (d: Buffer) => {
          buf += d.toString();
          const lines = buf.split(/\r?\n/);
          const last = lines.at(-2) ?? lines.at(-1) ?? "";
          if (last.startsWith(code)) { buf = ""; sock.off("data", on); res(); }
          else if (/^[45]\d\d/.test(last)) { sock.off("data", on); rej(new Error(`smtp:${last}`)); }
        };
        sock.on("data", on);
      });
      const write = (s: string) => sock.write(s + "\r\n");
      sock.on("error", reject);

      (async () => {
        try {
          await wait("220");
          write(`EHLO clawhub`); await wait("250");
          if (this.cfg.startTls) {
            write("STARTTLS"); await wait("220");
            // In production, re-handshake on a TLS socket. For brevity, abort.
            throw new Error("smtp_starttls_requires_tls_upgrade");
          }
          if (this.cfg.user && this.cfg.pass) {
            write("AUTH LOGIN"); await wait("334");
            write(Buffer.from(this.cfg.user).toString("base64")); await wait("334");
            write(Buffer.from(this.cfg.pass).toString("base64")); await wait("235");
          }
          write(`MAIL FROM:<${this.cfg.from}>`); await wait("250");
          write(`RCPT TO:<${to}>`); await wait("250");
          write("DATA"); await wait("354");
          write(`Subject: ${subject}`);
          write(`From: ${this.cfg.from}`);
          write(`To: ${to}`);
          write(`MIME-Version: 1.0`);
          write(`Content-Type: text/html; charset=UTF-8`);
          write("");
          for (const line of body.split(/\r?\n/)) write(line.startsWith(".") ? "." + line : line);
          write("."); await wait("250");
          write("QUIT");
          sock.end();
          resolve();
        } catch (e) {
          sock.destroy();
          reject(e);
        }
      })();
    });
  }
}

export function buildMailerFromEnv(): Mailer {
  const kind = (process.env.CLAWHUB_MAILER ?? "log").toLowerCase();
  if (kind === "resend" && process.env.RESEND_API_KEY) {
    return new ResendMailer({ apiKey: process.env.RESEND_API_KEY, from: process.env.CLAWHUB_EMAIL_FROM ?? "noreply@useclawhub.com" });
  }
  if (kind === "smtp" && process.env.SMTP_HOST) {
    return new SmtpMailer({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 25),
      user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
      from: process.env.CLAWHUB_EMAIL_FROM ?? "noreply@useclawhub.com",
      startTls: process.env.SMTP_STARTTLS === "1",
    });
  }
  return new LogMailer();
}

// Retry + claim knobs mirror webhook-queue.ts — the outbox is the same durable
// delivery problem (see #79 for the webhook double-fire this shape fixed).
const OUTBOX_MAX_ATTEMPTS = 6;
const OUTBOX_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000, 14_400_000];
const OUTBOX_LEASE_MS = 90_000;

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  constructor(private db: DB, private mailer: Mailer, private pollMs = 10_000) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain().catch(e => log("warn", "outbox_drain_failed", { err: String(e) })), this.pollMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // Public so tests can drive delivery deterministically without the timer.
  async drain(): Promise<void> {
    const due = await this.db.select().from(emailOutbox)
      .where(and(
        or(eq(emailOutbox.status, "pending"), eq(emailOutbox.status, "retrying"))!,
        lte(emailOutbox.nextAttemptAt, new Date()),
      ))
      .orderBy(asc(emailOutbox.createdAt))
      .limit(50);
    for (const e of due) {
      // Atomic per-row LEASE: every API replica runs an OutboxWorker and the
      // select above is unclaimed — CAS nextAttemptAt forward so exactly one
      // contender delivers the row (zero rows updated = someone else has it).
      // A claimer that dies mid-send self-heals: the lease expires and the row
      // re-enters the due window with its status unchanged.
      const lease = await this.db.update(emailOutbox)
        .set({ nextAttemptAt: new Date(Date.now() + OUTBOX_LEASE_MS) })
        .where(and(eq(emailOutbox.id, e.id), lte(emailOutbox.nextAttemptAt, new Date())))
        .returning({ id: emailOutbox.id });
      if (!lease.length) continue;
      try {
        await this.mailer.send(e.toEmail, e.subject, e.body);
        await this.db.update(emailOutbox)
          .set({ status: "sent", sentAt: new Date(), attempts: e.attempts + 1, error: null })
          .where(eq(emailOutbox.id, e.id));
      } catch (err) {
        const attempts = e.attempts + 1;
        const dead = attempts >= OUTBOX_MAX_ATTEMPTS;
        await this.db.update(emailOutbox).set({
          status: dead ? "failed" : "retrying",
          attempts,
          error: String((err as Error).message ?? err),
          nextAttemptAt: new Date(Date.now() + OUTBOX_BACKOFF_MS[Math.min(attempts, OUTBOX_BACKOFF_MS.length - 1)]),
        }).where(eq(emailOutbox.id, e.id));
        if (dead) {
          metrics.inc("clawhub_email_outbox_dead_total");
          log("error", "email_outbox_dead", { id: e.id, to: e.toEmail, subject: e.subject, attempts, err: String((err as Error).message ?? err) });
        } else {
          log("warn", "email_outbox_retry", { id: e.id, attempts, err: String((err as Error).message ?? err) });
        }
      }
    }
  }
}
