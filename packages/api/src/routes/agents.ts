import { Hono } from "hono";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, users } from "../models/schema.js";
import { hashToken, randomToken, signToken } from "../services/auth.js";
import { verifyTokenCached } from "../services/token-cache.js";
import { ensureUserHandle } from "../services/namespace.js";
import { AuthError, ConflictError, NotFoundError, ValidationError } from "../services/errors.js";
import { authMiddleware } from "../middleware/auth.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";
import { agentEmailDomain, uniquePersonalName } from "../services/personal-agent.js";

// Claim tokens are time-boxed so a leaked one expires on its own. The agent
// token stays sovereign: whoever holds it can always mint a fresh claim token.
const CLAIM_TOKEN_TTL_MS = Number(process.env.CLAWHUB_CLAIM_TOKEN_TTL_MS ?? 48 * 3600_000);

function claimExpiry(): Date {
  return new Date(Date.now() + CLAIM_TOKEN_TTL_MS);
}

// Default git-author email domain for agents. Derives from the configured
// public host (so a self-hosted instance authors from its own domain) and
// defaults to a domain ClawHub actually operates — never the dead `clawhub.dev`.
// agentEmailDomain + uniquePersonalName moved to services/personal-agent.ts
// (shared with the import flow, which attributes a human-run import to their
// personal agent server-side).

export function createAgentRoutes(db: DB): Hono {
  const app = new Hono();

  // Public: self-register an agent. If a valid *user* Bearer token rides along,
  // we auto-claim the agent for that user — no claim-token round-trip needed.
  app.post("/", async c => {
    const body = await c.req.json().catch(() => ({})) as { name?: string; gitAuthorName?: string; gitAuthorEmail?: string; capabilities?: { push?: boolean; review?: boolean } };
    if (!body.name) throw new ValidationError("name required");
    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(body.name)) throw new ValidationError("bad name");
    const existing = await db.select().from(agents).where(eq(agents.name, body.name)).limit(1);
    if (existing[0]) throw new ConflictError("name taken");

    // This is a public route (no middleware), so parse the header by hand. A
    // bad/expired/agent token just means "not auto-claimed" — never an error.
    let claimedByUserId: string | null = null;
    const authHeader = c.req.header("authorization") ?? "";
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.slice(7).trim();
      try {
        const payload = await verifyTokenCached(token);
        if (payload.kind === "user") claimedByUserId = payload.userId;
      } catch { /* unclaimed registration */ }
    }

    const claimToken = claimedByUserId ? null : randomToken(18);
    const claimTokenExpiresAt = claimedByUserId ? null : claimExpiry();
    const placeholder = await hashToken(randomToken(12));
    const inserted = await db.insert(agents).values({
      name: body.name,
      tokenHash: placeholder,
      claimToken,
      claimTokenExpiresAt,
      associatedUserId: claimedByUserId,
      gitAuthorName: body.gitAuthorName ?? body.name,
      gitAuthorEmail: body.gitAuthorEmail ?? `${body.name}@${agentEmailDomain()}`,
      capabilities: { push: body.capabilities?.push ?? true, review: body.capabilities?.review ?? false },
    }).returning();

    const agent = inserted[0];
    const token = signToken({ kind: "agent", agentId: agent.id, name: agent.name });
    await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, agent.id));

    return c.json({
      agent: { id: agent.id, name: agent.name, capabilities: agent.capabilities },
      token,
      // The repo owner for a headless agent is its same-named service-account
      // user (provisioned on first push). The remote path stays `<agent>/<repo>`.
      owner: agent.name,
      claimed: !!claimedByUserId,
      ...(claimedByUserId
        ? {}
        : { claim_token: claimToken, claim_token_expires_at: claimTokenExpiresAt!.toISOString() }),
    }, 201);
  });

  // Public: claim an agent by its claim_token — associate with current user.
  const protectedApp = new Hono();
  protectedApp.use("*", authMiddleware);

  protectedApp.post("/claim", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const body = await c.req.json().catch(() => ({})) as { claim_token?: string };
    if (!body.claim_token) throw new ValidationError("claim_token required");
    // Atomic compare-and-swap: burn the token and set the association in one
    // conditional UPDATE. Two concurrent claims on the same (leaked) token
    // can't both win — the second matches zero rows. The WHERE enforces
    // expiry server-side, so a leaked-but-stale token is dead. A valid
    // unexpired token may overwrite an existing association (the documented
    // recovery path — only the agent-token holder can mint a fresh token).
    const claimed = (await db.update(agents)
      .set({ associatedUserId: payload.userId, claimToken: null, claimTokenExpiresAt: null })
      .where(and(
        eq(agents.claimToken, body.claim_token),
        isNotNull(agents.claimTokenExpiresAt),
        gt(agents.claimTokenExpiresAt, new Date()),
      ))
      .returning({ id: agents.id, name: agents.name }))[0];
    // Same not-found whether the token is wrong, expired, or already burned —
    // a stale token reveals nothing.
    if (!claimed) throw new NotFoundError("claim token");
    return c.json({ agent: { id: claimed.id, name: claimed.name } });
  });

  protectedApp.get("/", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    // Live agents only — archived (removed) agents drop out of the caller's list.
    const rows = await db.select().from(agents).where(and(eq(agents.associatedUserId, payload.userId), isNull(agents.archivedAt)));
    return c.json({ agents: rows.map(r => ({ id: r.id, name: r.name, gitAuthorName: r.gitAuthorName, gitAuthorEmail: r.gitAuthorEmail, capabilities: r.capabilities, isPersonal: r.isPersonal, stats: r.stats, createdAt: r.createdAt })) });
  });

  // Remove (archive) one of the caller's agents. Soft-delete: the token is
  // revoked (a sentinel that no sha256(token) can match) and the agent drops out
  // of the list, but the row + the change/review history it authored are kept.
  // Standing deployments it had simply stop authenticating. Idempotent.
  protectedApp.delete("/:id", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const id = c.req.param("id");
    const row = (await db.select().from(agents).where(eq(agents.id, id)).limit(1))[0];
    // Scope: only an agent the caller has claimed (associatedUserId) is theirs to
    // remove. 404 (not 403) so we never leak the existence of others' agents.
    if (!row || row.associatedUserId !== payload.userId) throw new NotFoundError("agent");
    if (!row.archivedAt) {
      await db.update(agents).set({ archivedAt: new Date(), tokenHash: "archived" }).where(eq(agents.id, id));
    }
    return c.json({ ok: true });
  });

  // User: get-or-create the caller's personal agent. Solo developers get one
  // identity for "commit + review my own code" instead of juggling two. Returns
  // `owner` — the user's namespace handle — so the CLI wires the remote to
  // `<owner>/<repo>` (the user OWNS the repo; the agent is granted push).
  protectedApp.post("/personal", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const body = await c.req.json().catch(() => ({})) as { rotate?: boolean };
    const owner = await ensureUserHandle(db, payload.userId, payload.email);

    const existing = (await db.select().from(agents)
      .where(and(eq(agents.associatedUserId, payload.userId), eq(agents.isPersonal, true))).limit(1))[0];
    if (existing) {
      // Idempotent: a repeated call must NOT silently invalidate a working
      // token (that would break running agents and is a DoS once a user token
      // leaks). Only mint a fresh token when the caller explicitly asks —
      // e.g. they lost it and clicked "rotate".
      if (!body.rotate) {
        // No token is returned here (we never re-issue a working token implicitly).
        // Surface that explicitly so a caller who lost their token isn't left with
        // a silent "success" that can't actually push — tell them how to recover.
        return c.json({
          agent: { id: existing.id, name: existing.name, capabilities: existing.capabilities, isPersonal: true },
          owner, created: false, rotated: false,
          tokenWithheld: true,
          message: "Personal agent already exists; token not re-issued. Call again with { rotate: true } (or `ch init`) to mint a fresh token.",
        });
      }
      const token = signToken({ kind: "agent", agentId: existing.id, name: existing.name });
      await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, existing.id));
      return c.json({ agent: { id: existing.id, name: existing.name, capabilities: existing.capabilities, isPersonal: true }, owner, token, created: false, rotated: true });
    }

    const name = await uniquePersonalName(db, payload.email);
    const inserted = (await db.insert(agents).values({
      name,
      tokenHash: await hashToken(randomToken(12)),
      isPersonal: true,
      associatedUserId: payload.userId,
      gitAuthorName: name,
      gitAuthorEmail: `${name}@${agentEmailDomain()}`,
      capabilities: { push: true, review: true },
    }).returning())[0];
    const token = signToken({ kind: "agent", agentId: inserted.id, name: inserted.name });
    await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, inserted.id));
    return c.json({ agent: { id: inserted.id, name: inserted.name, capabilities: inserted.capabilities, isPersonal: true }, owner, token, created: true }, 201);
  });

  protectedApp.get("/me", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "agent") throw new AuthError("agent token required");
    const row = (await db.select().from(agents).where(eq(agents.id, payload.agentId)).limit(1))[0];
    if (!row) throw new NotFoundError("agent");
    return c.json({ id: row.id, name: row.name, capabilities: row.capabilities, stats: row.stats, claim_token: row.claimToken });
  });

  protectedApp.post("/:id/rotate-token", async c => {
    const payload = c.get("tokenPayload");
    const id = c.req.param("id");
    const row = (await db.select().from(agents).where(eq(agents.id, id)).limit(1))[0];
    if (!row) throw new NotFoundError("agent");
    if (payload.kind === "user" && row.associatedUserId !== payload.userId) throw new AuthError("not your agent");
    if (payload.kind === "agent" && row.id !== payload.agentId) throw new AuthError("not your agent");
    const token = signToken({ kind: "agent", agentId: row.id, name: row.name });
    await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, row.id));
    // Rotating an agent token revokes the prior one (the token cache verifies
    // against token_hash). Audit the actor + target agent — NEVER the token.
    await getAuditLog(db).record({
      actorKind: payload.kind === "user" ? "human" : "agent",
      actorId: payload.kind === "user" ? payload.userId : payload.agentId,
      action: "agent.token_rotated",
      category: "agent",
      metadata: { agentId: row.id, agentName: row.name },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
    return c.json({ token });
  });

  // Agent-only: mint a fresh claim token + expiry. The agent token is the
  // sovereign credential — a wrong or stale claim is always recoverable by
  // whoever controls the agent, not by whoever happened to claim it first.
  protectedApp.post("/:id/claim-token/rotate", async c => {
    const payload = c.get("tokenPayload");
    const id = c.req.param("id");
    if (payload.kind !== "agent" || payload.agentId !== id) throw new AuthError("agent token required");
    const row = (await db.select().from(agents).where(eq(agents.id, id)).limit(1))[0];
    if (!row) throw new NotFoundError("agent");
    const claimToken = randomToken(18);
    const expiresAt = claimExpiry();
    await db.update(agents).set({ claimToken, claimTokenExpiresAt: expiresAt }).where(eq(agents.id, row.id));
    return c.json({ claim_token: claimToken, expires_at: expiresAt.toISOString() });
  });

  app.route("/", protectedApp);
  return app;
}

// Ensure the user has a namespace handle (username), deriving one from their
// email on first need. The handle is the namespace they OWN repos under.
// Derive a globally-unique agent name from a user's email local part. Sanitize
// to the agents.name regex, suffix "-agent", and append a short random tail on
// collision.

