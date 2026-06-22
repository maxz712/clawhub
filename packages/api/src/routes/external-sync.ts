import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DB } from "../models/db.js";
import { AuthError } from "../services/errors.js";
import { resolveRepo } from "../services/repo-resolver.js";
import { decryptRepoSecrets } from "../services/ci-secrets.js";
import { handleJira, handleLinear } from "../services/external-sync.js";

// Real Jira/Linear webhooks cannot present a rotating user JWT — the old
// user-auth gate (throwing "users only") meant the documented "configure your
// provider to POST here" flow could never work end to end. Authenticate with a
// per-repo HMAC over the raw body instead (mirroring the chatops Slack/Discord
// scheme). The shared secret is stored as a normal sealed repo secret under a
// reserved name, set via the Secrets settings; synced issues are attributed to a
// SYSTEM actor (not a human). The full provider-config UI lands in Batch 8.
const JIRA_SECRET_NAME = "JIRA_WEBHOOK_SECRET";
const LINEAR_SECRET_NAME = "LINEAR_WEBHOOK_SECRET";
// A stable, well-known id for the "system" actor on synced issues. createdById
// has no FK, so a nil-UUID sentinel cleanly denotes "not a user/agent".
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Constant-time verify HMAC-SHA256 of the raw body against the per-repo secret.
 * Accepts `sha256=<hex>` (our scheme / Jira via a configured secret) or a bare
 * hex digest (Linear's `linear-signature`).
 */
export function verifyHmac(raw: string, secret: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const want = createHmac("sha256", secret).update(raw).digest("hex");
  const got = provided.startsWith("sha256=") ? provided.slice(7) : provided;
  let a: Buffer, b: Buffer;
  try { a = Buffer.from(want, "hex"); b = Buffer.from(got, "hex"); } catch { return false; }
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function authRepo(db: DB, ns: string, repoName: string, secretName: string, raw: string, sig: string | undefined) {
  // All failure modes — unknown repo, unconfigured secret, bad signature —
  // return the SAME 401. Distinguishing them (e.g. 404 for a missing repo) would
  // let an unauthenticated caller probe whether a PRIVATE repo exists.
  const resolved = await resolveRepo(db, ns, repoName);
  if (!resolved) throw new AuthError("unauthorized");
  const secrets = await decryptRepoSecrets(db, resolved.repo.id);
  const secret = secrets[secretName];
  if (!secret) throw new AuthError("unauthorized");
  if (!verifyHmac(raw, secret, sig)) throw new AuthError("unauthorized");
  return resolved.repo;
}

function safeJson(raw: string): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function createExternalSyncRoutes(db: DB): Hono {
  const app = new Hono();
  // NO authMiddleware: these are inbound provider webhooks, authenticated by the
  // per-repo HMAC over the raw body — never a user JWT.

  app.post("/:ns/:repo/jira", async c => {
    const raw = await c.req.text();
    const sig = c.req.header("x-clawhub-signature") ?? c.req.header("x-hub-signature-256");
    const repo = await authRepo(db, c.req.param("ns"), c.req.param("repo"), JIRA_SECRET_NAME, raw, sig);
    const result = await handleJira(db, repo.id, safeJson(raw) as never, { kind: "system", id: SYSTEM_ACTOR_ID });
    return c.json(result);
  });

  app.post("/:ns/:repo/linear", async c => {
    const raw = await c.req.text();
    const sig = c.req.header("linear-signature") ?? c.req.header("x-clawhub-signature");
    const repo = await authRepo(db, c.req.param("ns"), c.req.param("repo"), LINEAR_SECRET_NAME, raw, sig);
    const result = await handleLinear(db, repo.id, safeJson(raw) as never, { kind: "system", id: SYSTEM_ACTOR_ID });
    return c.json(result);
  });

  return app;
}
