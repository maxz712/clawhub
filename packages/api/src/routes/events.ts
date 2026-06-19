import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { repoCollaborators } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import type { TokenPayload } from "../services/auth.js";
import { verifyTokenCached } from "../services/token-cache.js";
import { AuthError } from "../services/errors.js";

// Operator runner agents (comma-separated agent ids) that may receive run-dispatch
// events for ANY repo — the shared CI/standing-agent runner pool. On a multi-tenant
// deployment leave this empty and run per-tenant runners whose agents collaborate
// on their own repos, so run dispatch (which carries the per-run runnerToken) never
// crosses a tenant boundary.
const RUNNER_AGENT_IDS = new Set((process.env.CLAWHUB_RUNNER_AGENT_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean));

// `ci.run.queued` carries the per-run runnerToken, which unlocks that run's secrets
// (for a standing run: the sealed agent JWT + BYO-LLM key). It must NOT broadcast to
// every authenticated subscriber. Only an authorized RUNNER (an agent in the operator
// allowlist, or an agent that collaborates on the run's repo) may receive it — never a
// plain user token.
async function mayReceiveRunDispatch(db: DB, payload: TokenPayload, repoId: string | undefined): Promise<boolean> {
  // Never to a user token — that is the realistic leak (anyone can sign up, then
  // scrape runnerTokens from the global stream). This is enforced unconditionally.
  if (payload.kind !== "agent") return false;
  // Agent scoping is OPT-IN: with no allowlist configured, any agent may receive
  // run dispatch (backward-compatible — the operator's runner keeps working with
  // no config). Set CLAWHUB_RUNNER_AGENT_IDS (+ run per-tenant runners) to also
  // stop run dispatch crossing tenant boundaries between agents.
  if (RUNNER_AGENT_IDS.size === 0) return true;
  if (RUNNER_AGENT_IDS.has(payload.agentId)) return true;
  if (!repoId) return false;
  const collab = (await db.select({ id: repoCollaborators.id }).from(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repoId), eq(repoCollaborators.agentId, payload.agentId))).limit(1))[0];
  return !!collab;
}

const RUN_DISPATCH_EVENTS = new Set(["ci.run.queued"]);

export function createEventRoutes(db: DB, events: EventBus): Hono {
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
    const payload = c.get("tokenPayload");
    const unsubscribe = events.onEvent(e => {
      // Credential-bearing run-dispatch events are scoped to authorized runners
      // only; everything else streams to the authenticated subscriber as before.
      if (RUN_DISPATCH_EVENTS.has(e.type)) {
        void mayReceiveRunDispatch(db, payload, e.repoId).then(ok => {
          if (ok) void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        });
        return;
      }
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
