import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { handleSlashCommand, verifyDiscordRequest, verifySlackSignature } from "../services/chatops.js";

export function createChatopsRoutes(db: DB): Hono {
  const app = new Hono();

  // Slack slash command endpoint. Register in Slack as POST /api/v1/chatops/slack.
  app.post("/slack", async c => {
    const body = await c.req.text();
    const ts = c.req.header("x-slack-request-timestamp") ?? "";
    const sig = c.req.header("x-slack-signature") ?? "";
    if (!verifySlackSignature(ts, body, sig)) {
      return c.json({ error: "bad_signature" }, 401);
    }
    const params = new URLSearchParams(body);
    const resp = await handleSlashCommand(db, {
      command: params.get("command") ?? "",
      text: params.get("text") ?? "",
      user_id: params.get("user_id") ?? "",
      user_name: params.get("user_name") ?? "",
      channel_id: params.get("channel_id") ?? "",
    });
    return c.json({ response_type: "in_channel", ...resp });
  });

  // Discord interactions endpoint.
  app.post("/discord", async c => {
    const body = await c.req.text();
    const ts = c.req.header("x-signature-timestamp") ?? "";
    const sig = c.req.header("x-signature-ed25519") ?? "";
    if (!verifyDiscordRequest(ts, body, sig)) return c.json({ error: "bad_signature" }, 401);
    const payload = JSON.parse(body) as { type: number; data?: { name?: string; options?: Array<{ name: string; value: string }> } };
    if (payload.type === 1) return c.json({ type: 1 });       // PING
    if (payload.type === 2) {
      const name = payload.data?.name ?? "";
      if (name === "clawhub") {
        const sub = payload.data?.options?.[0]?.value ?? "status";
        return c.json({ type: 4, data: { content: `ClawHub: ${sub}` } });
      }
    }
    return c.json({ type: 4, data: { content: "unsupported" } });
  });

  return app;
}
