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

      // Listen for client disconnect
      c.req.raw.signal.addEventListener("abort", () => {
        aborted = true;
      });

      // Send initial connection event
      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ message: "Connected to event stream" }),
      });

      // Poll Redis every 2 seconds for new events
      while (!aborted) {
        try {
          const events = await eventBus.readEvents(50, lastId);

          for (const event of events) {
            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify({
                type: event.type,
                repo_id: event.repoId,
                agent_id: event.agentId,
                data: event.data,
                timestamp: event.timestamp,
              }),
            });
          }

          // Update lastId if we got events (use timestamp-based approach)
          // Since readEvents returns from a given ID, we move forward
          if (events.length > 0) {
            // Use current time as next starting point
            lastId = String(Date.now());
          }
        } catch (error) {
          // Log but don't crash the stream
          console.error("SSE polling error:", error);
        }

        // Wait 2 seconds before next poll
        await stream.sleep(2000);
      }
    });
  });

  return app;
}
