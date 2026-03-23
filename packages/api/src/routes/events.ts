import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../services/events.js";

export function createEventRoutes(eventBus: EventBus) {
  const app = new Hono();

  // GET /api/v1/events/stream — SSE endpoint for real-time events
  app.get("/stream", async (c) => {
    return streamSSE(c, async (stream) => {
      let lastId = "$";
      let aborted = false;

      c.req.raw.signal.addEventListener("abort", () => {
        aborted = true;
      });

      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ message: "Connected to event stream" }),
      });

      while (!aborted) {
        try {
          const events = await eventBus.readEvents(50, lastId);

          for (const event of events) {
            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify({
                type: event.type,
                repo_id: event.repoId,
                actor_id: event.actorId,
                actor_type: event.actorType,
                data: event.data,
                timestamp: event.timestamp,
              }),
            });
          }

          if (events.length > 0) {
            lastId = String(Date.now());
          }
        } catch (error) {
          console.error("SSE polling error:", error);
        }

        await stream.sleep(2000);
      }
    });
  });

  return app;
}
