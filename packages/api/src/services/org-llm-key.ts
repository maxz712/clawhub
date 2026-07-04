import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgLlmKeys } from "../models/schema.js";
import { seal, unseal } from "./secrets.js";

// Org-connected LLM keys (N3 / the D2 fallback). An org pastes its OWN provider key
// once; the metering gateway then forwards that org's platform-keyed runs with the
// org's key instead of ClawHub's platform key. Sealed at rest with CLAWHUB_SECRETS_KEY
// (same as repo secrets); the plaintext is read ONLY in the API process at forward
// time and NEVER handed to a container. The org pays its provider directly, so
// ClawHub meters for visibility/governance but does not bill the platform SKU.

// Provider ids match standing_agents.llmProvider / the gateway protocol split.
export const ORG_KEY_PROVIDERS = new Set(["anthropic", "openai"]);
export function normalizeProvider(p: string | undefined | null): "anthropic" | "openai" | null {
  const v = (p ?? "").toLowerCase().trim();
  if (v === "anthropic") return "anthropic";
  if (v === "openai" || v === "openrouter") return "openai"; // openrouter speaks the openai protocol
  return null;
}

/** Seal + upsert an org's provider key (+ optional upstream baseUrl override). */
export async function setOrgLlmKey(db: DB, orgId: string, provider: "anthropic" | "openai", key: string, baseUrl?: string | null): Promise<void> {
  const sealed = seal(key);
  await db.insert(orgLlmKeys).values({
    orgId, provider, keyCiphertext: sealed.ciphertext, keyNonce: sealed.nonce, baseUrl: baseUrl ?? null,
  }).onConflictDoUpdate({
    target: [orgLlmKeys.orgId, orgLlmKeys.provider],
    set: { keyCiphertext: sealed.ciphertext, keyNonce: sealed.nonce, baseUrl: baseUrl ?? null, updatedAt: new Date() },
  });
}

/** The org's decrypted key + baseUrl for a provider, or null when none is connected. */
export async function getOrgLlmKey(db: DB, orgId: string, provider: "anthropic" | "openai"): Promise<{ key: string; baseUrl: string | null } | null> {
  const row = (await db.select().from(orgLlmKeys).where(and(eq(orgLlmKeys.orgId, orgId), eq(orgLlmKeys.provider, provider))).limit(1))[0];
  if (!row) return null;
  try { return { key: unseal(row.keyCiphertext, row.keyNonce), baseUrl: row.baseUrl }; }
  catch { return null; } // a key sealed under a rotated CLAWHUB_SECRETS_KEY → treat as absent (falls back to platform)
}

export async function deleteOrgLlmKey(db: DB, orgId: string, provider: "anthropic" | "openai"): Promise<void> {
  await db.delete(orgLlmKeys).where(and(eq(orgLlmKeys.orgId, orgId), eq(orgLlmKeys.provider, provider)));
}

/** Presence-only view (never the key) for the settings UI. */
export async function listOrgLlmKeys(db: DB, orgId: string): Promise<Array<{ provider: string; baseUrl: string | null; updatedAt: Date }>> {
  const rows = await db.select({ provider: orgLlmKeys.provider, baseUrl: orgLlmKeys.baseUrl, updatedAt: orgLlmKeys.updatedAt })
    .from(orgLlmKeys).where(eq(orgLlmKeys.orgId, orgId));
  return rows;
}
