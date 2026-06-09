import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../services/events.js";
import { verifyTokenCached } from "../services/token-cache.js";
import { AuthError } from "../services/errors.js";

export function createEventRoutes(events: EventBus): Hono {
  const app = new Hono();
  // EventSource cannot send headers, so the browser passes ?token=. Accept
  // either that or the normal Authorization header.
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    const token = header ?? c.req.query("token");
    if (!token) throw new AuthError("missing bearer token");
    try { c.set("tokenPayload", await verifyTokenCached(token)); }
    catch { throw new AuthError("invalid token"); }
    await next();
  });

  app.get("/stream", c => streamSSE(c, async stream => {
    const unsubscribe = events.onEvent(e => {
      void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
    });
    c.req.raw.signal.addEventListener("abort", () => unsubscribe());
    // Heartbeat
    while (!c.req.raw.signal.aborted) {
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      await stream.sleep(15_000);
    }
  }));

  return app;
}
