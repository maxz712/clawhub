import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { metrics } from "../services/metrics.js";

// Product tripwires (M8). A tiny, allowlisted telemetry sink: the client fires a
// named event, the server increments a bounded Prometheus counter. The allowlist
// caps metric cardinality (a client can't invent labels) — funnel signal without
// a metrics explosion. The M1 Review Brief fires focus events here.
const ALLOWED_EVENTS = new Set([
  "review_brief_rendered",   // a Review Brief was shown (focus floor is working)
  "focus_jumped",            // a reviewer clicked a derived-focus decision
  "advisory_shown",          // the native advisory card rendered
  "advisory_disabled",       // a repo opted out inline
  "verification_shown",      // the verification panel rendered
  "loop_wizard_opened",      // the Loop install wizard opened
  "loop_installed",          // a Loop was installed from the wizard
]);

export function createTelemetryRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/", async c => {
    const body = await c.req.json().catch(() => ({})) as { event?: string };
    const event = typeof body.event === "string" ? body.event : "";
    if (!ALLOWED_EVENTS.has(event)) return c.json({ ok: false, error: "unknown event" }, 400);
    metrics.inc("clawhub_telemetry_total", { event });
    return c.json({ ok: true });
  });

  return app;
}
