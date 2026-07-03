import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { resolveGatewayRun, recordPlatformUsage, type GatewayRun } from "../services/llm-gateway.js";
import { checkPlatformBudget } from "../services/platform-billing.js";
import { metrics } from "../services/metrics.js";
import { log } from "../services/logger.js";

// The platform-LLM metering gateway (M3). A platform-keyed run's container calls
// this with a per-run gateway token as its "API key"; we inject the real platform
// key, forward to Anthropic, stream the response back, and tee the SSE to meter
// token usage. The real key NEVER leaves the API process. Routes are shaped per
// PROTOCOL (`/anthropic/*` now; `/openai/*` reserved — D7) so a multi-model
// catalog can grow without re-plumbing.

const ANTHROPIC_UPSTREAM = (process.env.CLAWHUB_ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com").replace(/\/+$/, "");
const ANTHROPIC_VERSION = process.env.CLAWHUB_ANTHROPIC_VERSION ?? "2023-06-01";

function platformKey(): string | null {
  return process.env.CLAWHUB_PLATFORM_ANTHROPIC_KEY || null;
}

/** Extract the per-run gateway token from the Anthropic-style headers. */
function tokenFrom(headers: Headers): string {
  const xkey = headers.get("x-api-key");
  if (xkey) return xkey;
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function toUsageTokens(u: AnthropicUsage | undefined) {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Consume a tee'd SSE stream, metering usage as it arrives. Meter at
 * `message_start` (input + cache spend — so a severed stream still records
 * input) and FINALIZE at `message_delta` (final output tokens). Best-effort: a
 * parse failure fires the dead-man metric but never breaks the client stream.
 */
async function meterSse(db: DB, run: GatewayRun, model: string, stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let rowId: string | null = null;
  let inputUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let sawStart = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines; each `data:` line is JSON.
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt: { type?: string; message?: { usage?: AnthropicUsage }; usage?: AnthropicUsage };
        try { evt = JSON.parse(payload); }
        catch { metrics.inc("clawhub_llm_gateway_parse_fail_total", { where: "sse" }); continue; }
        if (evt.type === "message_start" && evt.message?.usage) {
          inputUsage = toUsageTokens(evt.message.usage);
          sawStart = true;
          rowId = await recordPlatformUsage(db, { run, model, usage: inputUsage, meta: { phase: "start" } });
        } else if (evt.type === "message_delta" && evt.usage) {
          const finalUsage = { ...inputUsage, outputTokens: evt.usage.output_tokens ?? inputUsage.outputTokens };
          rowId = await recordPlatformUsage(db, { run, model, usage: finalUsage, usageRowId: rowId, meta: { phase: "final" } });
        }
      }
    }
  } catch (e) {
    log("warn", "llm_gateway_meter_failed", { runId: run.runId, err: (e as Error).message });
  } finally {
    // A stream that produced no message_start at all is a parse/format anomaly —
    // fire the dead-man so the alert catches a silently-unmetered path.
    if (!sawStart) metrics.inc("clawhub_llm_gateway_parse_fail_total", { where: "no_message_start" });
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

export function createLlmGatewayRoutes(db: DB): Hono {
  const app = new Hono();

  // Anthropic Messages API — the container's ANTHROPIC_BASE_URL points here.
  app.post("/anthropic/v1/messages", async c => {
    const key = platformKey();
    if (!key) return c.json({ error: { type: "not_configured", message: "platform LLM key not configured" } }, 503);
    const run = await resolveGatewayRun(db, tokenFrom(c.req.raw.headers));
    if (!run) {
      metrics.inc("clawhub_llm_gateway_reject_total", { reason: "bad_token" });
      return c.json({ error: { type: "authentication_error", message: "invalid or expired gateway token" } }, 401);
    }
    // Per-request budget re-check (M7): a HARD-block tenant that blew its cap
    // mid-run stops here — the container can't keep spending the platform key past
    // the budget. byo_fallback/queue tenants aren't blocked at the gateway (the
    // dispatch gate already steered them); only an explicit `block` denies here.
    try {
      const budget = await checkPlatformBudget(db, { orgId: run.orgId, userId: run.userId });
      if (budget.mode === "block") {
        metrics.inc("clawhub_llm_gateway_reject_total", { reason: "budget_block" });
        return c.json({ error: { type: "billing_error", message: "platform budget exhausted" } }, 402);
      }
    } catch { /* budget lookup best-effort — never fail-closed on a DB blip */ }
    const bodyText = await c.req.text();
    let model = "unknown";
    let streaming = false;
    try { const b = JSON.parse(bodyText); model = b.model ?? "unknown"; streaming = !!b.stream; } catch { /* forward as-is */ }

    let upstream: Response;
    try {
      upstream = await fetch(`${ANTHROPIC_UPSTREAM}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": c.req.raw.headers.get("anthropic-version") ?? ANTHROPIC_VERSION,
          ...(c.req.raw.headers.get("anthropic-beta") ? { "anthropic-beta": c.req.raw.headers.get("anthropic-beta")! } : {}),
        },
        body: bodyText,
      });
    } catch (e) {
      metrics.inc("clawhub_llm_gateway_reject_total", { reason: "upstream_unreachable" });
      log("error", "llm_gateway_upstream_failed", { err: (e as Error).message });
      return c.json({ error: { type: "api_error", message: "upstream unavailable" } }, 502);
    }
    metrics.inc("clawhub_llm_gateway_request_total", { streaming: String(streaming), status: String(upstream.status) });

    if (streaming && upstream.body && upstream.ok) {
      const [toClient, toMeter] = upstream.body.tee();
      // Meter in the background — never block the client stream on the DB.
      void meterSse(db, run, model, toMeter);
      return new Response(toClient, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" },
      });
    }

    // Non-streaming (or an error response): read the full JSON, meter once.
    const text = await upstream.text();
    if (upstream.ok) {
      try {
        const parsed = JSON.parse(text) as { model?: string; usage?: AnthropicUsage };
        await recordPlatformUsage(db, { run, model: parsed.model ?? model, usage: toUsageTokens(parsed.usage), meta: { phase: "nonstream" } });
      } catch { metrics.inc("clawhub_llm_gateway_parse_fail_total", { where: "nonstream" }); }
    }
    return new Response(text, { status: upstream.status, headers: { "content-type": "application/json" } });
  });

  // Models list — proxy through with the platform key so a client can enumerate.
  app.get("/anthropic/v1/models", async c => {
    const key = platformKey();
    if (!key) return c.json({ error: { type: "not_configured", message: "platform LLM key not configured" } }, 503);
    if (!(await resolveGatewayRun(db, tokenFrom(c.req.raw.headers)))) {
      return c.json({ error: { type: "authentication_error", message: "invalid or expired gateway token" } }, 401);
    }
    const upstream = await fetch(`${ANTHROPIC_UPSTREAM}/v1/models`, {
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
    }).catch(() => null);
    if (!upstream) return c.json({ error: { type: "api_error", message: "upstream unavailable" } }, 502);
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { "content-type": "application/json" } });
  });

  return app;
}
