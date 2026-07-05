import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { resolveGatewayRun, recordPlatformUsage, type GatewayRun } from "../services/llm-gateway.js";
import { getOrgLlmKey } from "../services/org-llm-key.js";
import { checkPlatformBudget } from "../services/platform-billing.js";
import { globalCapExceeded } from "../services/platform-quota.js";
import { catalogEntry, providerBlock, modelForRequest, catalogPriceMicroUsd, openModelCatalog, type CatalogEntry } from "../services/llm-catalog.js";
import { metrics } from "../services/metrics.js";
import { log } from "../services/logger.js";

// The platform-LLM metering gateway (M3). A platform-keyed run's container calls
// this with a per-run gateway token as its "API key"; we inject the real platform
// key, forward upstream, stream the response back, and tee the SSE to meter token
// usage. The real key NEVER leaves the API process. Routes are shaped per PROTOCOL:
// `/anthropic/*` (the Anthropic Messages gateway) and `/openai/*` (the OpenRouter
// gateway — D8, with SERVER-FORCED US-host pinning; a container names only a model
// and we inject the provider routing block it cannot widen).

// `||` not `??`: docker-compose passes these as EMPTY strings when unset in .env
// (`${VAR:-}`), and an empty string is present-but-falsy — `??` would keep the ""
// and build a relative `/chat/completions` that fetch() rejects ("Failed to parse
// URL"), 502-ing every platform-keyed call. `||` falls back on empty too.
const ANTHROPIC_UPSTREAM = (process.env.CLAWHUB_ANTHROPIC_UPSTREAM || "https://api.anthropic.com").replace(/\/+$/, "");
const ANTHROPIC_VERSION = process.env.CLAWHUB_ANTHROPIC_VERSION || "2023-06-01";
const OPENROUTER_UPSTREAM = (process.env.CLAWHUB_PLATFORM_OPENAI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");

function platformKey(): string | null {
  return process.env.CLAWHUB_PLATFORM_ANTHROPIC_KEY || null;
}

function openRouterKey(): string | null {
  return process.env.CLAWHUB_PLATFORM_OPENAI_KEY || null;
}

// D10 · per-request input-token ceiling (giant-diff blowout guard). A rough chars/4
// estimate is enough to reject a runaway prompt at the gateway before it bills.
// Default 50k tokens; env-tunable (-1 disables). `||` not `??`: compose passes the
// var as an EMPTY string when unset (`${VAR:-}`) and Number("") is 0, which the
// `> 0` check below read as "ceiling disabled" — the D10 guard was silently OFF.
const MAX_INPUT_TOKENS = Number(process.env.CLAWHUB_PLATFORM_MAX_INPUT_TOKENS) || 50_000;
function estimatedInputTokens(bodyText: string): number { return Math.ceil(bodyText.length / 4); }
function overInputCeiling(bodyText: string): boolean {
  return MAX_INPUT_TOKENS > 0 && estimatedInputTokens(bodyText) > MAX_INPUT_TOKENS;
}

// D8/D10 hardening: the container body is prompt-injectable, so forward ONLY an
// allowlist of GENERATION fields — never ROUTING fields. Dropping `models` (a fallback
// array that would serve an un-benched model past the catalog pin), `preset` (a saved
// config that can widen provider/data_collection), `plugins` (OpenRouter's server-side
// web plugin = an out-of-band egress/exfil channel run under the PLATFORM key, bypassing
// the container's egress:none), `route`/`transforms`, and any container-supplied
// `provider` (we set our own). Everything not listed is dropped.
const OPENAI_ALLOWED = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens",
  "stream", "stop", "seed", "tools", "tool_choice", "response_format",
  "frequency_penalty", "presence_penalty", "logit_bias", "n", "logprobs", "top_logprobs",
  "parallel_tool_calls", "reasoning", "user",
]);
const ANTHROPIC_ALLOWED = new Set([
  "model", "messages", "system", "max_tokens", "temperature", "top_p", "top_k",
  "stop_sequences", "stream", "tools", "tool_choice", "metadata", "thinking",
]);
function pickAllowed(body: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (allowed.has(k)) out[k] = body[k];
  return out;
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
async function meterSse(db: DB, run: GatewayRun, model: string, stream: ReadableStream<Uint8Array>, keyOwner: "org" | "platform" = "platform"): Promise<void> {
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
          rowId = await recordPlatformUsage(db, { run, model, usage: inputUsage, meta: { phase: "start" }, keyOwner });
        } else if (evt.type === "message_delta" && evt.usage) {
          const finalUsage = { ...inputUsage, outputTokens: evt.usage.output_tokens ?? inputUsage.outputTokens };
          rowId = await recordPlatformUsage(db, { run, model, usage: finalUsage, usageRowId: rowId, meta: { phase: "final" }, keyOwner });
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

// ── OpenAI / OpenRouter protocol (D8) ──────────────────────────────────────

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  cost?: number;                // OpenRouter: authoritative USD charge for the call
}

/** Map OpenAI-shaped usage → our token buckets. `cached_tokens` is a SUBSET of
 * `prompt_tokens` (unlike Anthropic), so uncached input = prompt − cached. */
function openAiToUsageTokens(u: OpenAiUsage | undefined) {
  const prompt = u?.prompt_tokens ?? 0;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: u?.prompt_tokens_details?.cache_write_tokens ?? 0,
  };
}

/** Cost (micro-USD) from an OpenAI/OpenRouter usage: prefer the authoritative
 * `usage.cost` (USD); fall back to the catalog price when absent. */
function openAiCostMicroUsd(entry: CatalogEntry, u: OpenAiUsage | undefined): number {
  if (u && typeof u.cost === "number" && Number.isFinite(u.cost)) return Math.ceil(u.cost * 1_000_000);
  return catalogPriceMicroUsd(entry, openAiToUsageTokens(u));
}

/**
 * Consume a tee'd OpenAI SSE stream and meter once from the FINAL chunk (the one
 * with a non-null `usage` + empty `choices`). Best-effort — never breaks the
 * client stream; fires the dead-man metric if no usage chunk ever arrives.
 */
async function meterOpenAiSse(db: DB, run: GatewayRun, model: string, entry: CatalogEntry, stream: ReadableStream<Uint8Array>, keyOwner: "org" | "platform" = "platform"): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sawUsage = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt: { usage?: OpenAiUsage | null };
        try { evt = JSON.parse(payload); }
        catch { metrics.inc("clawhub_llm_gateway_parse_fail_total", { where: "sse_openai" }); continue; }
        if (evt.usage) {
          sawUsage = true;
          await recordPlatformUsage(db, {
            run, model,
            usage: openAiToUsageTokens(evt.usage),
            costMicroUsd: openAiCostMicroUsd(entry, evt.usage),
            meta: { phase: "final", protocol: "openai", host: entry.host },
            keyOwner,
          });
        }
      }
    }
  } catch (e) {
    log("warn", "llm_gateway_meter_failed", { runId: run.runId, err: (e as Error).message });
  } finally {
    if (!sawUsage) metrics.inc("clawhub_llm_gateway_parse_fail_total", { where: "no_openai_usage" });
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

export function createLlmGatewayRoutes(db: DB): Hono {
  const app = new Hono();

  // Anthropic Messages API — the container's ANTHROPIC_BASE_URL points here.
  app.post("/anthropic/v1/messages", async c => {
    const run = await resolveGatewayRun(db, tokenFrom(c.req.raw.headers));
    if (!run) {
      metrics.inc("clawhub_llm_gateway_reject_total", { reason: "bad_token" });
      return c.json({ error: { type: "authentication_error", message: "invalid or expired gateway token" } }, 401);
    }
    // N3 org-connected key: use the org's OWN Anthropic key (+ optional baseUrl) for
    // its runs; else ClawHub's platform key. Org-key usage is metered keyOwner='org'
    // (org pays Anthropic directly; not ClawHub overage / global ceiling).
    const orgKey = run.orgId ? await getOrgLlmKey(db, run.orgId, "anthropic") : null;
    const key = orgKey?.key ?? platformKey();
    if (!key) return c.json({ error: { type: "not_configured", message: "no Anthropic key configured (platform or org)" } }, 503);
    const anthropicBase = (orgKey?.baseUrl || ANTHROPIC_UPSTREAM).replace(/\/+$/, "");
    const keyOwner: "org" | "platform" = orgKey ? "org" : "platform";
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
    // D10 global ceiling — the hard server-side backstop under the OpenRouter/Anthropic
    // prepaid wall; bounds overshoot to in-flight concurrency.
    if (await globalCapExceeded()) {
      metrics.inc("clawhub_llm_gateway_reject_total", { reason: "global_cap" });
      return c.json({ error: { type: "billing_error", message: "platform spend ceiling reached" } }, 402);
    }
    const rawText = await c.req.text();
    if (overInputCeiling(rawText)) {
      metrics.inc("clawhub_llm_gateway_reject_total", { reason: "input_ceiling" });
      return c.json({ error: { type: "invalid_request_error", message: "request exceeds the platform input-token ceiling" } }, 413);
    }
    // Allowlist the body (same rationale as the OpenRouter route — the container is
    // prompt-injectable): keep only Messages generation fields, drop anything else.
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(rawText) as Record<string, unknown>; }
    catch { metrics.inc("clawhub_llm_gateway_reject_total", { reason: "bad_body" }); return c.json({ error: { type: "invalid_request_error", message: "body must be JSON" } }, 400); }
    const model = typeof raw.model === "string" ? raw.model : "unknown";
    const streaming = !!raw.stream;
    const bodyText = JSON.stringify(pickAllowed(raw, ANTHROPIC_ALLOWED));

    let upstream: Response;
    try {
      upstream = await fetch(`${anthropicBase}/v1/messages`, {
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
      void meterSse(db, run, model, toMeter, keyOwner);
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
        await recordPlatformUsage(db, { run, model: parsed.model ?? model, usage: toUsageTokens(parsed.usage), meta: { phase: "nonstream" }, keyOwner });
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

  // OpenAI Chat Completions API → OpenRouter, US-host-pinned (D8). The container's
  // OPENAI_BASE_URL points here; codex/any OpenAI-SDK CLI POSTs Chat Completions.
  // We REJECT any model the catalog doesn't list, then FORCE the provider routing
  // block (US hosts only, no outside fallback, deny data-collection, pinned quant)
  // over whatever the container sent — it cannot route itself off a qualified host.
  app.post("/openai/v1/chat/completions", async c => {
    const run = await resolveGatewayRun(db, tokenFrom(c.req.raw.headers));
    if (!run) {
      metrics.inc("clawhub_llm_gateway_reject_total", { reason: "bad_token" });
      return c.json({ error: { type: "authentication_error", message: "invalid or expired gateway token" } }, 401);
    }
    // N3 org-connected key: if this run's ORG has pasted its own key, forward with
    // THAT key (+ optional baseUrl) — the org pays its provider directly, so the
    // usage is metered but not billed as platform overage (keyOwner='org'). The
    // catalog pin (US-host provider block) is still forced below regardless.
    const orgKey = run.orgId ? await getOrgLlmKey(db, run.orgId, "openai") : null;
    const key = orgKey?.key ?? openRouterKey();
    if (!key) return c.json({ error: { type: "not_configured", message: "no open-model key configured (platform or org)" } }, 503);
    const upstreamBase = (orgKey?.baseUrl || OPENROUTER_UPSTREAM).replace(/\/+$/, "");
    const keyOwner: "org" | "platform" = orgKey ? "org" : "platform";
    try {
      const budget = await checkPlatformBudget(db, { orgId: run.orgId, userId: run.userId });
      if (budget.mode === "block") {
        metrics.inc("clawhub_llm_gateway_reject_total", { reason: "budget_block" });
        return c.json({ error: { type: "billing_error", message: "platform budget exhausted" } }, 402);
      }
    } catch { /* budget lookup best-effort */ }
    if (await globalCapExceeded()) {
      metrics.inc("clawhub_llm_gateway_reject_total", { reason: "global_cap" });
      return c.json({ error: { type: "billing_error", message: "platform spend ceiling reached" } }, 402);
    }

    // We must be able to PARSE the body to inject the pin — an unparseable body
    // can't be pinned, so it's rejected rather than forwarded unpinned.
    const bodyText = await c.req.text();
    if (overInputCeiling(bodyText)) {
      metrics.inc("clawhub_llm_gateway_reject_total", { reason: "input_ceiling" });
      return c.json({ error: { type: "invalid_request_error", message: "request exceeds the platform input-token ceiling" } }, 413);
    }
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(bodyText) as Record<string, unknown>; }
    catch { metrics.inc("clawhub_llm_gateway_reject_total", { reason: "bad_body" }); return c.json({ error: { type: "invalid_request_error", message: "body must be JSON" } }, 400); }

    const requestedModel = typeof raw.model === "string" ? raw.model : "";
    const entry = catalogEntry(requestedModel);
    if (!entry) {
      // A model outside the qualified (model, host, quant) catalog is refused — a
      // prompt-injected reviewer cannot route to an unqualified or PRC-first-party host.
      metrics.inc("clawhub_llm_gateway_reject_total", { reason: "uncatalogued_model" });
      return c.json({ error: { type: "invalid_request_error", message: `model "${requestedModel}" is not in the qualified open-model catalog` } }, 400);
    }

    // Rebuild the body from the ALLOWLIST (drops models/route/preset/plugins/transforms/
    // provider), THEN force the pin + resolved model. The container cannot smuggle a
    // routing field past this.
    const streaming = !!raw.stream;
    const body = pickAllowed(raw, OPENAI_ALLOWED);
    body.provider = providerBlock(entry);
    body.model = modelForRequest(entry);
    if (streaming) body.stream_options = { include_usage: true };

    let upstream: Response;
    try {
      upstream = await fetch(`${upstreamBase}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${key}`,
          "HTTP-Referer": "https://useclawhub.com",
          "X-Title": "ClawHub",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      metrics.inc("clawhub_llm_gateway_reject_total", { reason: "upstream_unreachable" });
      log("error", "llm_gateway_openai_upstream_failed", { err: (e as Error).message });
      return c.json({ error: { type: "api_error", message: "upstream unavailable" } }, 502);
    }
    metrics.inc("clawhub_llm_gateway_request_total", { streaming: String(streaming), status: String(upstream.status), protocol: "openai" });

    if (streaming && upstream.body && upstream.ok) {
      const [toClient, toMeter] = upstream.body.tee();
      void meterOpenAiSse(db, run, entry.id, entry, toMeter, keyOwner);
      return new Response(toClient, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" },
      });
    }

    const text = await upstream.text();
    if (upstream.ok) {
      try {
        const parsed = JSON.parse(text) as { model?: string; usage?: OpenAiUsage };
        await recordPlatformUsage(db, {
          run, model: entry.id,
          usage: openAiToUsageTokens(parsed.usage),
          costMicroUsd: openAiCostMicroUsd(entry, parsed.usage),
          meta: { phase: "nonstream", protocol: "openai", host: entry.host },
          keyOwner,
        });
      } catch { metrics.inc("clawhub_llm_gateway_parse_fail_total", { where: "nonstream_openai" }); }
    }
    return new Response(text, { status: upstream.status, headers: { "content-type": "application/json" } });
  });

  // Models list — served from the qualified catalog (no upstream call). A CLI that
  // probes /models sees exactly the routable set, in OpenAI's list shape.
  app.get("/openai/v1/models", async c => {
    if (!openRouterKey()) return c.json({ error: { type: "not_configured", message: "platform open-model key not configured" } }, 503);
    if (!(await resolveGatewayRun(db, tokenFrom(c.req.raw.headers)))) {
      return c.json({ error: { type: "authentication_error", message: "invalid or expired gateway token" } }, 401);
    }
    const data = Object.values(openModelCatalog()).map(e => ({ id: e.id, object: "model", owned_by: e.host }));
    return c.json({ object: "list", data });
  });

  return app;
}
