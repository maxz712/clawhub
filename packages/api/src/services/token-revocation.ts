import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, users } from "../models/schema.js";
import { matchesHash, type TokenPayload } from "./auth.js";

/**
 * DB-backed token revocation. A JWT signature proves who minted a token,
 * not that it is still welcome — this check ties each token back to a
 * living row:
 *
 *  - agent tokens must match agents.token_hash, so POST
 *    /agents/:id/rotate-token revokes the previous token;
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
      return matchesHash(token, row.tokenHash);
    }
    const row = (await db.select({ tokenVersion: users.tokenVersion }).from(users)
      .where(eq(users.id, payload.userId)).limit(1))[0];
    if (!row) return false;
    return (payload.v ?? 0) === row.tokenVersion;
  };
}
