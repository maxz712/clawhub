import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { secrets, standingAgents } from "../models/schema.js";
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

/**
 * The secret VALUES a run's output could plausibly contain — the input to log
 * masking (#142), never returned to a caller.
 *
 * Deliberately NOT `standingRunEnv()`: that builds the whole dispatch env and
 * MINTS a fresh per-run gateway token as a side effect, so calling it from the
 * log sink (which the runner hits every few seconds while streaming) would both
 * cost a memory-pack build per log flush and rotate `ci_runs.gatewayTokenHash`
 * out from under the container that is still using it. Only the two sealed
 * values matter here — the agent push JWT and the BYO-LLM key — and both come
 * straight off the standing-agent row.
 *
 * Best-effort per value: an unrecoverable seal (rotated key) yields one fewer
 * mask pattern, not a thrown log write. A pipeline run reuses the authoritative
 * `decryptRepoSecrets`, whose fail-closed unseal error the caller must handle.
 */
export async function runSecretValues(
  db: DB,
  run: { repoId: string; standingAgentId: string | null }
): Promise<string[]> {
  if (run.standingAgentId) {
    const sa = (await db.select().from(standingAgents).where(eq(standingAgents.id, run.standingAgentId)).limit(1))[0];
    if (!sa) return [];
    const out: string[] = [];
    if (sa.tokenCiphertext && sa.tokenNonce) {
      try { out.push(unseal(sa.tokenCiphertext, sa.tokenNonce)); }
      catch { log("warn", "ci_log_redact_token_unseal_failed", { standingAgentId: sa.id }); }
    }
    if (sa.llmCiphertext && sa.llmNonce) {
      try { out.push(unseal(sa.llmCiphertext, sa.llmNonce)); }
      catch { log("warn", "ci_log_redact_llm_unseal_failed", { standingAgentId: sa.id }); }
    }
    return out;
  }
  return Object.values(await decryptRepoSecrets(db, run.repoId));
}
