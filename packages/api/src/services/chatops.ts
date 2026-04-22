import { createHmac, timingSafeEqual } from "node:crypto";
import type { DB } from "../models/db.js";

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
    case "/clawhub change":
      return { text: `Change lookup: ${args[0] ?? "<id>"} — (stub: resolve via /api/v1/repos/:ns/:repo/changes/:id)` };
    case "/clawhub approve": {
      const id = args[0];
      if (!id) return { text: "Usage: `/clawhub approve <change-url>`" };
      return { text: `Received approval request for ${id}. (Wire this to an actual repo context to auto-approve.)` };
    }
    default:
      return { text: `Commands: \`status\`, \`change <id>\`, \`approve <url>\`. See https://clawhub.dev/docs/slack.` };
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
