import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, users } from "../models/schema.js";
import { matchesHash, type TokenPayload } from "./auth.js";
import { AuthError } from "./errors.js";
import { isAgentKilled } from "./kill-switch.js";

/**
 * Refuse to mint a session for a DEPROVISIONED account (#133). The revocation
 * checker below already rejects a disabled user's EXISTING tokens; this is the
 * mirror for the sign-in paths that mint new ones (password login, OAuth,
 * OIDC, SAML) so an IdP deactivation is not silently undone by re-authenticating
 * through a different door. Kept next to the revocation check so the two
 * halves of "is this principal still welcome" cannot drift apart.
 */
export function assertNotDeprovisioned(user: { disabledAt?: Date | null }): void {
  if (user.disabledAt) throw new AuthError("account_disabled");
}

/**
 * DB-backed token revocation. A JWT signature proves who minted a token,
 * not that it is still welcome — this check ties each token back to a
 * living row:
 *
 *  - agent tokens must match agents.token_hash, so POST
 *    /agents/:id/rotate-token revokes the previous token;
 *  - a KILLED agent's token is treated as revoked, so engaging the kill
 *    switch stops the agent at the AUTH boundary — its token fails both REST
 *    (authMiddleware) and git (authenticateGitRequestCached) within the cache
 *    TTL, before any request reaches a handler or lands on disk;
 *  - user tokens carry a `v` claim checked against users.token_version, so
 *    bumping the version ends every session for that user at once;
 *  - a DEPROVISIONED user (users.disabled_at set — SCIM `active:false`) is
 *    denied outright, so an IdP deactivation ends REST and git access;
 *  - deleted principals fail outright.
 *
 * Wired into the token cache (`setRevocationChecker`), which means one DB
 * lookup per token per cache TTL and revocation propagating within that TTL
 * (60s Redis + 5s in-process by default).
 */
export function makeRevocationChecker(db: DB): (payload: TokenPayload, token: string) => Promise<boolean> {
  return async (payload, token) => {
    if (payload.kind === "agent") {
      const row = (await db.select({ tokenHash: agents.tokenHash }).from(agents)
        .where(eq(agents.id, payload.agentId)).limit(1))[0];
      if (!row) return false;
      if (!(await matchesHash(token, row.tokenHash))) return false;
      // A killed agent is denied at the auth boundary — its token is treated
      // exactly like a rotated/revoked one. Only affects killed agents; a
      // non-killed agent with a matching hash is unaffected.
      if (await isAgentKilled(db, payload.agentId)) return false;
      return true;
    }
    const row = (await db.select({ tokenVersion: users.tokenVersion, disabledAt: users.disabledAt }).from(users)
      .where(eq(users.id, payload.userId)).limit(1))[0];
    if (!row) return false;
    // A DEPROVISIONED human is denied here too (#133) — the SCIM `active:false`
    // an IdP sends when an employee leaves. It also bumps token_version, so the
    // `v` comparison below already kills every token minted before the disable;
    // this check is what keeps a token minted DURING the disabled window (or a
    // future re-mint path we forget to guard) from working. Same shape as the
    // killed-agent branch: one gate, both REST and git, within the cache TTL.
    if (row.disabledAt) return false;
    return (payload.v ?? 0) === row.tokenVersion;
  };
}
