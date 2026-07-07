import { serve } from "@hono/node-server";
import nacl from "tweetnacl";
import util from "tweetnacl-util";
import { db } from "./models/db.js";
import { GitService } from "./services/git.js";
import { EventBus } from "./services/events.js";
import { buildApp } from "./app.js";
import { isSecretsKeyConfigured } from "./services/secrets.js";

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

serve({ fetch: app.fetch, port });
console.log(`[clawhub] api listening on :${port}`);
void migrateInlineKeys();
