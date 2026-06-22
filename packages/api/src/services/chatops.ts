import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, repositories } from "../models/schema.js";
import { namespaceNameOf } from "./namespace.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_URL = process.env.CLAWHUB_PUBLIC_URL ?? "https://useclawhub.com";

const SLACK_SIGNING_SECRET = process.env.CLAWHUB_SLACK_SIGNING_SECRET ?? "";
const DISCORD_PUBLIC_KEY = process.env.CLAWHUB_DISCORD_PUBLIC_KEY ?? "";

export function verifySlackSignature(timestamp: string, body: string, signature: string): boolean {
  if (!SLACK_SIGNING_SECRET) return false;
  const base = `v0:${timestamp}:${body}`;
  const hmac = "v0=" + createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex");
  try {
    const a = Buffer.from(hmac);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

export interface SlackCommand { command: string; text: string; user_id: string; user_name: string; channel_id: string }

export async function handleSlashCommand(db: DB, cmd: SlackCommand): Promise<{ text: string; blocks?: unknown[] }> {
  const [action, ...args] = cmd.text.trim().split(/\s+/);
  switch ((cmd.command + " " + (action ?? "")).trim()) {
    case "/clawhub status":
      return { text: "ClawHub is up. Ship something, agents." };
    case "/clawhub change": {
      // Real, read-only lookup. A Slack request is not an authenticated ClawHub
      // user, so we ONLY surface a change in a PUBLIC repo (never a private one —
      // that would leak). Validate the id so a non-UUID can't blow up the query.
      const id = args[0];
      if (!id || !UUID_RE.test(id)) return { text: "Usage: `/clawhub change <change-id>` (a UUID)." };
      const ch = (await db.select().from(changes).where(eq(changes.id, id)).limit(1))[0];
      if (!ch) return { text: `No change found for \`${id}\`.` };
      const repo = (await db.select().from(repositories).where(eq(repositories.id, ch.repoId)).limit(1))[0];
      if (!repo?.isPublic) return { text: `Change \`${id}\` is in a private repo — open it in the ClawHub dashboard.` };
      const ns = await namespaceNameOf(db, repo.namespaceType, repo.namespaceId);
      const link = ns ? ` ${PUBLIC_URL}/r/${ns}/${repo.name}/changes/${ch.id}` : "";
      return { text: `*${ch.intent || "(no intent)"}* — status: ${ch.status}, risk: ${ch.computedRisk ?? ch.risk}.${link}` };
    }
    default:
      // The old `/clawhub approve` was a no-op that PRETENDED to approve — removed.
      // Approval requires reading the actual code (the Review-Focus gate), so it
      // can't be a one-word Slack command; it happens in the dashboard.
      return { text: `Commands: \`status\`, \`change <id>\`. Approving a Change happens in the ClawHub dashboard — a review must rest on the code, so it isn't a Slack one-liner. See ${PUBLIC_URL}/docs/slack.` };
  }
}

export async function postToSlackWebhook(webhookUrl: string, payload: { text: string; blocks?: unknown[] }): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch { return false; }
}

export async function postToDiscordWebhook(webhookUrl: string, payload: { content: string; embeds?: unknown[] }): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch { return false; }
}

export function verifyDiscordRequest(timestamp: string, body: string, signature: string): boolean {
  if (!DISCORD_PUBLIC_KEY) return false;
  try {
    const sig = Buffer.from(signature, "hex");
    const msg = Buffer.from(timestamp + body);
    const key = Buffer.from(DISCORD_PUBLIC_KEY, "hex");
    // Discord uses ed25519; verify via node:crypto subtle API.
    const crypto = require("node:crypto");
    const pubKey = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]), key]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, msg, pubKey, sig);
  } catch { return false; }
}
