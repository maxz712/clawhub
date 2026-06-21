import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { repoCollaborators } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import type { TokenPayload } from "../services/auth.js";
import { verifyTokenCached } from "../services/token-cache.js";
import { canReadRepoId } from "../services/repo-access.js";
import { AuthError } from "../services/errors.js";

// Operator runner agents (comma-separated agent ids) that may receive run-dispatch
// events for ANY repo — the shared CI/standing-agent runner pool. This is an
// opt-in escape hatch. With NO allowlist configured, run dispatch is NOT broadcast
// to every agent (that leaked per-run runnerTokens across tenants); instead each
// agent only receives dispatch for repos it collaborates on. So a per-tenant
// deployment can leave this empty and run per-tenant runners whose agents
// collaborate on their own repos — run dispatch (which carries the per-run
// runnerToken) never crosses a tenant boundary either way.
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
  // An explicitly-allowlisted operator runner receives dispatch for ANY repo —
  // the shared CI/standing-agent runner pool. This is the opt-in escape hatch.
  if (RUNNER_AGENT_IDS.has(payload.agentId)) return true;
  // Default (no allowlist OR an agent not on it): an agent may only receive a
  // run-dispatch event for a repo it COLLABORATES on. Previously, with no
  // allowlist configured, run dispatch broadcast to EVERY agent — leaking the
  // per-run runnerToken (which unlocks that run's sealed secrets) across tenant
  // boundaries. Scope it to the run's repo so a runnerToken never reaches an
  // agent with no stake in the repo. A run-dispatch event with no repoId is
  // never deliverable under the default path (no repo to authorize against).
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
      // Every other repo-scoped event (reviews, comments, issues, CI status, …)
      // must only reach subscribers who can READ that repo — otherwise the stream
      // leaks private-repo activity to anyone with a token (audit 2026-06-20).
      // Global (no-repoId) events still broadcast.
      void canReadRepoId(db, e.repoId, payload).then(ok => {
        if (ok) void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      });
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
