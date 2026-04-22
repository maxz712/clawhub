import type { Context, Next } from "hono";
import { log, newRequestId, newTraceparent, parseTraceparent } from "../services/logger.js";
import { metrics } from "../services/metrics.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    traceId: string;
    spanId: string;
  }
}

export async function observability(c: Context, next: Next) {
  const started = Date.now();
  const reqIdHeader = c.req.header("x-request-id");
  const requestId = reqIdHeader ?? newRequestId();
  const parsed = parseTraceparent(c.req.header("traceparent"));
  const { traceId, spanId, header } = parsed
    ? { traceId: parsed.traceId, spanId: parsed.spanId, header: `00-${parsed.traceId}-${parsed.spanId}-${parsed.flags}` }
    : newTraceparent();
  c.set("requestId", requestId);
  c.set("traceId", traceId);
  c.set("spanId", spanId);
  c.header("x-request-id", requestId);
  c.header("traceparent", header);

  let status = 500;
  try {
    await next();
    status = c.res.status;
  } catch (e) {
    status = 500;
    log("error", "request_failed", { requestId, traceId, method: c.req.method, path: c.req.path, err: (e as Error).message });
    throw e;
  } finally {
    const dur = Date.now() - started;
    const route = normalizeRoute(c.req.path);
    metrics.inc("clawhub_http_requests_total", { method: c.req.method, status: String(status), route });
    metrics.observe("clawhub_http_request_ms", dur, { method: c.req.method, route });
    log("info", "request", {
      requestId, traceId, spanId,
      method: c.req.method, path: c.req.path, status, durationMs: dur,
    });
  }
}

function normalizeRoute(path: string): string {
  // Collapse UUIDs and numeric IDs to keep cardinality low.
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d{3,}/g, "/:n");
}
