import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, users } from "../models/schema.js";
import { matchesHash, type TokenPayload } from "./auth.js";
import { isAgentKilled } from "./kill-switch.js";

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
    const row = (await db.select({ tokenVersion: users.tokenVersion }).from(users)
      .where(eq(users.id, payload.userId)).limit(1))[0];
    if (!row) return false;
    return (payload.v ?? 0) === row.tokenVersion;
  };
}
