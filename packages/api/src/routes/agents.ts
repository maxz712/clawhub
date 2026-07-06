import { Hono } from "hono";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { accessRoles, agentRoles, agents } from "../models/schema.js";
import { hashToken, randomToken, signToken } from "../services/auth.js";
import { verifyTokenCached } from "../services/token-cache.js";
import { ensureUserHandle } from "../services/namespace.js";
import { AuthError, ConflictError, NotFoundError, ValidationError } from "../services/errors.js";
import { authMiddleware } from "../middleware/auth.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";
import { agentEmailDomain, ensurePersonalAgent } from "../services/personal-agent.js";

// v3 (docs/redesign-v3.md §9): the claim flow is REMOVED. Agents are created
// by humans (auto-claimed at registration when a user Bearer rides along, or
// via the dashboard create flow); wrapper identities replace claiming
// end-to-end. The claim_token columns remain in the schema, orphaned, until a
// later cleanup migration.

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

    // v2 agents-ux: agents are created BY humans. Anonymous self-registration
    // is closed on the hosted product — a valid user Bearer must ride along
    // (auto-claim). Self-host/dev instances can reopen it with
    // CLAWHUB_ALLOW_UNCLAIMED_AGENT_REGISTER=1 (also set for the test suite).
    if (!claimedByUserId && process.env.CLAWHUB_ALLOW_UNCLAIMED_AGENT_REGISTER !== "1") {
      throw new AuthError("agent registration requires a human account — send your ClawHub user token as the Bearer (the agent is auto-claimed to you), or create the agent from the dashboard");
    }

    const placeholder = await hashToken(randomToken(12));
    const inserted = await db.insert(agents).values({
      name: body.name,
      tokenHash: placeholder,
      associatedUserId: claimedByUserId,
      createdByUserId: claimedByUserId,
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
    }, 201);
  });

  const protectedApp = new Hono();
  protectedApp.use("*", authMiddleware);

  protectedApp.get("/", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    // Live agents only — archived (removed) agents drop out of the caller's list.
    const rows = await db.select().from(agents).where(and(eq(agents.associatedUserId, payload.userId), isNull(agents.archivedAt)));
    // Tag agents minted BY a role deployment (two-kinds model, docs/agents-ux.md):
    // they are deployment infrastructure, and the roster groups them apart from
    // the user's personal/claimed identities. Server-truth, not name matching.
    const ids = rows.map(r => r.id);
    const roleRows = ids.length
      ? await db.select({ agentId: agentRoles.agentId, roleName: agentRoles.name }).from(agentRoles)
          .where(and(inArray(agentRoles.agentId, ids), isNotNull(agentRoles.agentId)))
      : [];
    const roleByAgent = new Map(roleRows.map(r => [r.agentId, r.roleName]));
    // v2: surface the ACCESS role name so the roster can chip what each agent
    // may do without a second fetch.
    const accessIds = [...new Set(rows.map(r => r.accessRoleId).filter((x): x is string => !!x))];
    const accessRows = accessIds.length
      ? await db.select({ id: accessRoles.id, name: accessRoles.name }).from(accessRoles).where(inArray(accessRoles.id, accessIds))
      : [];
    const accessById = new Map(accessRows.map(r => [r.id, r.name]));
    return c.json({ agents: rows.map(r => ({ id: r.id, name: r.name, gitAuthorName: r.gitAuthorName, gitAuthorEmail: r.gitAuthorEmail, capabilities: r.capabilities, isPersonal: r.isPersonal, stats: r.stats, createdAt: r.createdAt, roleName: roleByAgent.get(r.id) ?? null, accessRoleName: r.accessRoleId ? (accessById.get(r.accessRoleId) ?? null) : null })) });
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

    // v3: ONE code path mints the default personal agent (register hook and
    // this endpoint converge here) — Developer role, dormant until deployed.
    const inserted = await ensurePersonalAgent(db, payload.userId, payload.email);
    const token = signToken({ kind: "agent", agentId: inserted.id, name: inserted.name });
    await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, inserted.id));
    return c.json({ agent: { id: inserted.id, name: inserted.name, capabilities: inserted.capabilities, isPersonal: true }, owner, token, created: true }, 201);
  });

  protectedApp.get("/me", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "agent") throw new AuthError("agent token required");
    const row = (await db.select().from(agents).where(eq(agents.id, payload.agentId)).limit(1))[0];
    if (!row) throw new NotFoundError("agent");
    return c.json({ id: row.id, name: row.name, capabilities: row.capabilities, stats: row.stats });
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

  app.route("/", protectedApp);
  return app;
}

// Ensure the user has a namespace handle (username), deriving one from their
// email on first need. The handle is the namespace they OWN repos under.
// Derive a globally-unique agent name from a user's email local part. Sanitize
// to the agents.name regex, suffix "-agent", and append a short random tail on
// collision.

