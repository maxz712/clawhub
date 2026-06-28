import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { secrets } from "../models/schema.js";
import { GitError } from "./errors.js";
import { log } from "./logger.js";
import { unseal } from "./secrets.js";

/**
 * Return all repo secrets decrypted as `{ name: value }`. Used by CI runners
 * that authenticate with the per-run runnerToken. Never return this payload
 * over endpoints that aren't bound to a specific, auth'd runner.
 */
export async function decryptRepoSecrets(db: DB, repoId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(secrets).where(eq(secrets.repoId, repoId));
  const out: Record<string, string> = {};
  for (const r of rows) {
    // A legitimately-absent value is skipped quietly; a PRESENT sealed value that
    // fails AEAD authentication (tampering / wrong key) must NOT be silently dropped.
    if (!r.ciphertext || !r.nonce) continue; // genuinely absent — skip quietly.
    try {
      out[r.name] = unseal(r.ciphertext, r.nonce);
    } catch (e) {
      // SECURITY: fail closed — unseal/AEAD failure on a present sealed value means
      // tampering or key misconfiguration; surface it loudly instead of shipping the
      // run with the secret silently missing.
      log("error", "ci_secret_unseal_failed", { repoId, secretName: r.name, error: (e as Error).message });
      throw new GitError(`failed to decrypt secret '${r.name}' for repo ${repoId}`);
    }
  }
  return out;
}
