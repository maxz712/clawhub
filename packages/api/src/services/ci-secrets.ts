import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { secrets } from "../models/schema.js";
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
    try {
      out[r.name] = unseal(r.ciphertext, r.nonce);
    } catch {
      // Fail open for missing key/broken row.
    }
  }
  return out;
}
