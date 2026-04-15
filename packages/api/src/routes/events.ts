import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";

export function createEventRoutes(events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

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
