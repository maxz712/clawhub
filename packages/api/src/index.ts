import { serve } from "@hono/node-server";
import nacl from "tweetnacl";
import util from "tweetnacl-util";
import { db } from "./models/db.js";
import { GitService } from "./services/git.js";
import { EventBus } from "./services/events.js";
import { buildApp } from "./app.js";
import { isSecretsKeyConfigured, unseal } from "./services/secrets.js";

const port = Number(process.env.PORT ?? 3000);
const reposPath = process.env.GIT_REPOS_BASE_PATH ?? "./data/repos";

// Boot-time secrets-key guard, mirroring enforceJwtSecret(). In production a
// missing/invalid CLAWHUB_SECRETS_KEY must fail fast (not silently seal with the
// zero dev key) — validate it's a real 32-byte base64 key, the same check
// services/secrets.ts applies. Dev/test stay on a warning.
if ((process.env.NODE_ENV ?? "") === "production") {
  const raw = process.env.CLAWHUB_SECRETS_KEY ?? "";
  let ok = false;
  try { ok = !!raw && util.decodeBase64(raw).length === nacl.secretbox.keyLength; } catch { ok = false; }
  if (!ok) throw new Error(`CLAWHUB refuses to start in production without a valid 32-byte base64 CLAWHUB_SECRETS_KEY`);
} else if (!isSecretsKeyConfigured()) {
  console.warn("[clawhub] CLAWHUB_SECRETS_KEY not set — secrets API will reject writes.");
}

const git = new GitService(reposPath);
const events = new EventBus();
const app = buildApp({ db, git, events });

import { isNotNull, isNull, and, eq } from "drizzle-orm";
import { llmKeys, standingAgents } from "./models/schema.js";

async function migrateInlineKeys() {
  try {
    const sas = await db.select().from(standingAgents).where(and(
      isNotNull(standingAgents.llmCiphertext),
      isNull(standingAgents.llmKeyId),
      isNotNull(standingAgents.createdByUserId)
    ));
    if (sas.length === 0) return;

    console.log(`[clawhub] found ${sas.length} standing agents with inline keys to migrate`);
    for (const sa of sas) {
      if (!sa.createdByUserId || !sa.llmCiphertext || !sa.llmNonce) continue;

      let keyId: string;
      const [existing] = await db.select().from(llmKeys).where(and(
        eq(llmKeys.ownerUserId, sa.createdByUserId),
        eq(llmKeys.ciphertext, sa.llmCiphertext)
      )).limit(1);

      if (existing) {
        keyId = existing.id;
        console.log(`[clawhub] reuse existing vault key ${keyId} for agent ${sa.name}`);
      } else {
        const [inserted] = await db.insert(llmKeys).values({
          ownerUserId: sa.createdByUserId,
          name: `${sa.name} Key`,
          provider: sa.llmProvider,
          ciphertext: sa.llmCiphertext,
          nonce: sa.llmNonce,
        }).returning({ id: llmKeys.id });
        keyId = inserted.id;
        console.log(`[clawhub] migrated inline key to vault key ${keyId} for agent ${sa.name}`);
      }

      await db.update(standingAgents).set({ llmKeyId: keyId }).where(eq(standingAgents.id, sa.id));
    }
  } catch (err) {
    console.error("[clawhub] failed to migrate inline keys:", err);
  }
}

async function deduplicateVaultKeys() {
  try {
    const keysList = await db.select().from(llmKeys);
    if (keysList.length <= 1) return;

    console.log(`[clawhub] scanning ${keysList.length} vault keys for duplicates`);
    const seenPlaintexts = new Map<string, { id: string; name: string }>();

    for (const keyRow of keysList) {
      if (!keyRow.ciphertext || !keyRow.nonce) continue;

      let plaintext: string;
      try {
        plaintext = unseal(keyRow.ciphertext, keyRow.nonce);
      } catch (err) {
        console.error(`[clawhub] failed to decrypt key ${keyRow.id} during dedup:`, err);
        continue;
      }

      const match = seenPlaintexts.get(plaintext);
      if (match) {
        console.log(`[clawhub] key ${keyRow.id} (${keyRow.name}) is duplicate of ${match.id} (${match.name})`);

        const updated = await db.update(standingAgents)
          .set({ llmKeyId: match.id })
          .where(eq(standingAgents.llmKeyId, keyRow.id))
          .returning();

        console.log(`[clawhub] remapped ${updated.length} standing agents from ${keyRow.id} to ${match.id}`);

        await db.delete(llmKeys).where(eq(llmKeys.id, keyRow.id));
        console.log(`[clawhub] deleted duplicate vault key ${keyRow.id}`);
      } else {
        seenPlaintexts.set(plaintext, { id: keyRow.id, name: keyRow.name });
      }
    }
  } catch (err) {
    console.error("[clawhub] failed to deduplicate keys:", err);
  }
}

serve({ fetch: app.fetch, port });
console.log(`[clawhub] api listening on :${port}`);
void (async () => {
  await migrateInlineKeys();
  await deduplicateVaultKeys();
})();
