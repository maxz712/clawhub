import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers, users } from "../models/schema.js";
import { hashPassword } from "../services/auth.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";
import { deleteUserAccount } from "../services/gdpr.js";
import type { GitService } from "../services/git.js";
import { ensureUserHandle } from "../services/namespace.js";
import { resolveScimScope, type ScimScope } from "../services/scim-tokens.js";
import { randomBytes } from "node:crypto";

// SCIM 2.0 — Users endpoint. This is the surface Okta / Azure AD / OneLogin
// call to provision and DEPROVISION employees, so both deprovisioning
// operations have to be correct (#133):
//
//  - `active:false` (what an IdP's "Deactivate" action sends by default)
//    DISABLES the account — users.disabled_at plus a token_version bump, so
//    every outstanding session dies at the auth boundary. It used to be a
//    silent no-op answered 200 with a hardcoded `"active": true`, which made
//    the IdP record a successful deprovision that never happened.
//  - `DELETE` runs the ONE deletion cascade (`gdpr.ts:deleteUserAccount`). It
//    used to be a raw `db.delete(users)`, which left the departed employee's
//    agents alive with valid tokens and their repos orphaned on disk under a
//    freed handle — adoptable, with all of their private history, by anyone who
//    took the name.
//
// Auth is a bearer token that resolves to a SCOPE (services/scim-tokens.ts):
// a per-org token confines every operation to that org's members; the legacy
// instance-wide CLAWHUB_SCIM_TOKEN is retained for single-tenant self-hosts.

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ScimEnv = { Variables: { scimScope: ScimScope } };
type UserRow = typeof users.$inferSelect;

/** SCIM's error envelope. `status` is a STRING in the spec. */
function scimError(c: Context<ScimEnv>, status: 400 | 401 | 404 | 409, detail: string, scimType?: string): Response {
  return c.json({ schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail }, status);
}

export function createScimRoutes(db: DB, git: GitService): Hono<ScimEnv> {
  const app = new Hono<ScimEnv>();

  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return scimError(c, 401, "unauthorized");
    const scope = await resolveScimScope(db, match[1]);
    if (!scope) return scimError(c, 401, "unauthorized");
    c.set("scimScope", scope);
    await next();
  });

  app.get("/ServiceProviderConfig", c => c.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer", description: "OAuth bearer" }],
  }));

  app.get("/Schemas", c => c.json({
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    Resources: [{
      id: USER_SCHEMA,
      name: "User",
      attributes: [
        { name: "userName", type: "string", required: true },
        { name: "emails", type: "complex", multiValued: true, required: true },
        { name: "displayName", type: "string" },
        { name: "active", type: "boolean" },
      ],
    }],
  }));

  app.get("/Users", async c => {
    const scope = c.get("scimScope");
    const filter = c.req.query("filter") ?? "";
    const emailMatch = filter.match(/userName\s+eq\s+"([^"]+)"/i);
    const rows = await db.select().from(users)
      .where(and(...listConditions(scope), ...(emailMatch ? [eq(users.email, emailMatch[1].trim().toLowerCase())] : [])))
      .orderBy(desc(users.createdAt)).limit(200);
    return c.json({ schemas: [LIST_SCHEMA], totalResults: rows.length, Resources: rows.map(toScimUser) });
  });

  app.get("/Users/:id", async c => {
    const row = await userInScope(db, c.get("scimScope"), c.req.param("id"));
    if (!row) return scimError(c, 404, "user not found");
    return c.json(toScimUser(row));
  });

  app.post("/Users", async c => {
    const scope = c.get("scimScope");
    const body = await c.req.json().catch(() => ({})) as {
      userName?: string; displayName?: string; active?: unknown;
      emails?: Array<{ value: string; primary?: boolean }>;
    };
    const raw = body.userName ?? body.emails?.find(e => e.primary)?.value ?? body.emails?.[0]?.value;
    if (!raw) return scimError(c, 400, "email required", "invalidValue");
    // Normalize like every other account-resolution path — one address is one
    // account, and a differently-cased userName must not mint a duplicate.
    const email = raw.trim().toLowerCase();
    // `active` is optional on create, but if it IS sent it must be HONOURED —
    // quietly provisioning an account the IdP asked to be inactive is the same
    // class of lie the PATCH path used to tell.
    let active = true;
    if (body.active !== undefined) {
      try { active = toBool(body.active, "active"); }
      catch (e) { return scimError(c, 400, (e as Error).message, "invalidValue"); }
    }
    const disabledAt = active ? null : new Date();

    // Never pull a service-kind account (gh-mirror / clawhub-system / per-agent
    // owners) into the caller's org — consistent with the list/read paths which
    // already exclude them, and closing the #153 amplification that resolved one
    // into an org and made it SSO-absorbable.
    const existing = (await db.select().from(users).where(and(eq(users.email, email), ne(users.kind, "service"))).limit(1))[0];
    if (existing) {
      // Idempotent re-provision. Under an org scope this ALSO (re)asserts the
      // membership the scope is defined by, which is what makes a subsequent
      // GET/PATCH/DELETE of this id resolve. `source: scim` is NOT consent, so it
      // cannot authorize SSO account resolution (#153).
      if (scope.orgId) await db.insert(orgMembers).values({ orgId: scope.orgId, userId: existing.id, source: "scim" }).onConflictDoNothing();
      const handled = existing.username ? existing : await withHandle(db, existing);
      return c.json(toScimUser(handled), 200);
    }

    const pw = await hashPassword(randomBytes(32).toString("hex"));
    const [row] = await db.insert(users).values({ email, name: body.displayName ?? null, passwordHash: pw, disabledAt }).returning();
    // A SCIM-provisioned user with no handle is unresolvable as a namespace and
    // cannot be pushed to or displayed. Nothing else was ever going to mint one
    // (they have a random password and no verification mail), so mint it here.
    const created = await withHandle(db, row);
    if (scope.orgId) await db.insert(orgMembers).values({ orgId: scope.orgId, userId: created.id, source: "scim" }).onConflictDoNothing();
    await audit(c, db, scope, "scim.user.provisioned", created.id);
    return c.json(toScimUser(created), 201);
  });

  app.patch("/Users/:id", async c => {
    const scope = c.get("scimScope");
    const body = await c.req.json().catch(() => ({})) as {
      Operations?: Array<{ op?: string; path?: string; value?: unknown }>;
    };
    const ops = body.Operations;
    if (!Array.isArray(ops) || ops.length === 0) return scimError(c, 400, "Operations required", "invalidValue");

    // Validate EVERY operation before applying ANY of them. An IdP has to be
    // able to tell that its deprovisioning did not happen — answering 200 to a
    // request we silently dropped is the whole bug — and a partially applied
    // patch would leave the account in a state neither side believes in.
    let patch: ParsedPatch;
    try {
      patch = parsePatch(ops);
    } catch (e) {
      return scimError(c, 400, (e as Error).message, "invalidPath");
    }

    const row = await userInScope(db, scope, c.req.param("id"));
    if (!row) return scimError(c, 404, "user not found");

    const update: Partial<typeof users.$inferInsert> = {};
    if (patch.displayName !== undefined) update.name = patch.displayName;
    if (patch.active === false) {
      update.disabledAt = new Date();
      // Bump the session version so revocation is IMMEDIATE for every token
      // already minted, not merely TTL-bounded by the disabled_at check.
      update.tokenVersion = sql`${users.tokenVersion} + 1` as unknown as number;
    } else if (patch.active === true) {
      update.disabledAt = null;
    }
    if (Object.keys(update).length) await db.update(users).set(update).where(eq(users.id, row.id));

    if (patch.active === false) await audit(c, db, scope, "scim.user.deactivated", row.id);
    else if (patch.active === true && row.disabledAt) await audit(c, db, scope, "scim.user.reactivated", row.id);
    else if (Object.keys(update).length) await audit(c, db, scope, "scim.user.updated", row.id);

    const fresh = (await db.select().from(users).where(eq(users.id, row.id)).limit(1))[0];
    return c.json(toScimUser(fresh ?? row));
  });

  app.delete("/Users/:id", async c => {
    const scope = c.get("scimScope");
    const row = await userInScope(db, scope, c.req.param("id"));
    // An id the caller may not act on — another org's user, or one that never
    // existed — must read as 404. Answering 204 told the IdP it had deleted
    // something it had no right to and that may not have existed.
    if (!row) return scimError(c, 404, "user not found");
    // Route through the ONE cascade (gdpr.ts): archive + token-revoke the
    // user's agents, drop their standing deployments, delete their
    // own-namespace repos from the DB *and* disk, scrub billing/audit
    // attribution. Awaited — the 204 must mean it happened.
    await deleteUserAccount(db, git, row.id);
    // Recorded after the fact, and WITHOUT the address: the cascade is an
    // erasure, so the trail keeps the event and the opaque id, not the PII.
    await audit(c, db, scope, "scim.user.deleted", row.id);
    return new Response(null, { status: 204 });
  });

  return app;
}

/**
 * Scope predicate for the LIST endpoint. An org-scoped token sees that org's
 * members and nobody else. `service` users (the auto-provisioned owners of
 * headless agents' repos) are never IdP-managed identities and are hidden from
 * SCIM entirely, so an IdP can neither enumerate nor delete one.
 */
function listConditions(scope: ScimScope): SQL[] {
  const conds: SQL[] = [ne(users.kind, "service")];
  if (scope.orgId) {
    conds.push(sql`${users.id} in (select ${orgMembers.userId} from ${orgMembers} where ${orgMembers.orgId} = ${scope.orgId})`);
  }
  return conds;
}

/**
 * Resolve `:id` WITHIN the caller's scope. Anything the caller may not act on —
 * a malformed id, a nonexistent one, a service account, or a user outside the
 * token's org — comes back null so the route answers 404 rather than leaking
 * existence or acting across a tenant boundary.
 */
async function userInScope(db: DB, scope: ScimScope, id: string): Promise<UserRow | null> {
  if (!UUID_RE.test(id)) return null;
  const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
  if (!row || row.kind === "service") return null;
  if (scope.orgId) {
    const member = (await db.select({ id: orgMembers.id }).from(orgMembers)
      .where(and(eq(orgMembers.orgId, scope.orgId), eq(orgMembers.userId, id))).limit(1))[0];
    if (!member) return null;
  }
  return row;
}

async function withHandle(db: DB, row: UserRow): Promise<UserRow> {
  const username = await ensureUserHandle(db, row.id, row.email, row.username ?? null);
  return { ...row, username };
}

async function audit(c: Context<ScimEnv>, db: DB, scope: ScimScope, action: string, userId: string): Promise<void> {
  await getAuditLog(db).record({
    // The actor is the IdP holding a provisioning credential, not a ClawHub
    // identity — `system`, with the scope recorded in the metadata.
    actorKind: "system",
    action,
    category: "admin",
    metadata: { orgId: scope.orgId, scimTokenId: scope.tokenId, targetUserId: userId },
    ip: ipFromContext(c),
    userAgent: userAgentFromContext(c),
  });
}

interface ParsedPatch {
  displayName?: string;
  active?: boolean;
}

/**
 * Parse a SCIM PatchOp body into the fields we implement, THROWING on anything
 * we don't. Both shapes an IdP sends for the same intent are accepted:
 *
 *   {"op":"replace","path":"active","value":false}      // path form
 *   {"op":"replace","value":{"active":false}}           // pathless form (Okta)
 *
 * Azure AD sends the value as the STRING "False", so booleans are coerced from
 * either representation — but only from those two, never truthiness.
 */
function parsePatch(ops: Array<{ op?: string; path?: string; value?: unknown }>): ParsedPatch {
  const out: ParsedPatch = {};
  for (const op of ops) {
    const verb = String(op.op ?? "").toLowerCase();
    if (verb !== "replace" && verb !== "add") throw new Error(`unsupported op "${op.op}"`);
    if (op.path) {
      assign(out, op.path, op.value);
      continue;
    }
    if (!op.value || typeof op.value !== "object" || Array.isArray(op.value)) {
      throw new Error("pathless operation requires an object value");
    }
    for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) assign(out, k, v);
  }
  return out;
}

function assign(out: ParsedPatch, path: string, value: unknown): void {
  // Strip an urn:-qualified prefix (`urn:…:User:active`) an IdP may send.
  const attr = path.split(":").pop()!.trim().toLowerCase();
  if (attr === "displayname") { out.displayName = value == null ? "" : String(value); return; }
  if (attr === "active") { out.active = toBool(value, path); return; }
  throw new Error(`unsupported path "${path}"`);
}

function toBool(value: unknown, path: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  throw new Error(`"${path}" must be a boolean`);
}

function toScimUser(u: Pick<UserRow, "id" | "email" | "name" | "createdAt" | "disabledAt"> & { username?: string | null }) {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    userName: u.email,
    displayName: u.name,
    ...(u.username ? { nickName: u.username } : {}),
    emails: [{ value: u.email, primary: true, type: "work" }],
    // DERIVED, never a literal: a deprovisioned account must serialize as
    // inactive so the IdP's reconciliation sees the state it asked for.
    active: !u.disabledAt,
    meta: { resourceType: "User", created: u.createdAt, location: `/api/v1/scim/v2/Users/${u.id}` },
  };
}
