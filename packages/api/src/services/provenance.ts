import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { attestations, signingKeys, type Attestation } from "../models/schema.js";

export interface AttestationInput {
  repoId: string;
  changeId?: string | null;
  commitSha: string;
  agentId: string;
  agentVersion?: string;
  modelName?: string;
  modelVersion?: string;
  promptHash?: string;
  framework?: string;
  toolsUsed?: string[];
  testsRun?: boolean;
  typechecked?: boolean;
  extra?: Record<string, unknown>;
}

export async function ensureSigningKey(db: DB): Promise<{ keyId: string; privateKey: string; publicKey: string }> {
  const active = (await db.select().from(signingKeys).where(eq(signingKeys.active, true)).orderBy(desc(signingKeys.createdAt)).limit(1))[0];
  if (active) return { keyId: active.keyId, privateKey: active.privateKey, publicKey: active.publicKey };

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const privPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const keyId = `clawhub-${randomUUID()}`;

  await db.insert(signingKeys).values({
    keyId, kind: "ed25519", publicKey: pubPem, privateKey: privPem, active: true,
  });

  return { keyId, privateKey: privPem, publicKey: pubPem };
}

export async function rotateSigningKey(db: DB): Promise<{ keyId: string }> {
  // Existing key remains valid for verification; we just flip "active" + create a new one.
  await db.update(signingKeys).set({ active: false, rotatedAt: new Date() }).where(eq(signingKeys.active, true));
  const k = await ensureSigningKey(db);
  return { keyId: k.keyId };
}

export function canonicalAttestation(input: Omit<AttestationInput, "extra"> & { extra?: Record<string, unknown> }): string {
  const ordered = {
    agentId: input.agentId,
    agentVersion: input.agentVersion ?? null,
    changeId: input.changeId ?? null,
    commitSha: input.commitSha,
    extra: input.extra ?? {},
    framework: input.framework ?? null,
    modelName: input.modelName ?? null,
    modelVersion: input.modelVersion ?? null,
    promptHash: input.promptHash ?? null,
    repoId: input.repoId,
    testsRun: input.testsRun ?? false,
    toolsUsed: input.toolsUsed ?? [],
    typechecked: input.typechecked ?? false,
  };
  return JSON.stringify(ordered);
}

export async function createAttestation(db: DB, input: AttestationInput): Promise<Attestation> {
  const { keyId, privateKey } = await ensureSigningKey(db);
  const canonical = canonicalAttestation(input);
  const sig = cryptoSign(null, Buffer.from(canonical), createPrivateKey(privateKey));
  const [row] = await db.insert(attestations).values({
    repoId: input.repoId,
    changeId: input.changeId ?? null,
    commitSha: input.commitSha,
    agentId: input.agentId,
    agentVersion: input.agentVersion ?? null,
    modelName: input.modelName ?? null,
    modelVersion: input.modelVersion ?? null,
    promptHash: input.promptHash ?? null,
    framework: input.framework ?? null,
    toolsUsed: input.toolsUsed ?? [],
    testsRun: input.testsRun ?? false,
    typechecked: input.typechecked ?? false,
    signature: sig.toString("base64"),
    signingKeyId: keyId,
    extra: input.extra ?? {},
  }).returning();
  return row;
}

export async function verifyAttestation(db: DB, attestation: Attestation): Promise<boolean> {
  if (!attestation.signature || !attestation.signingKeyId) return false;
  const key = (await db.select().from(signingKeys).where(eq(signingKeys.keyId, attestation.signingKeyId)).limit(1))[0];
  if (!key) return false;
  const canonical = canonicalAttestation({
    repoId: attestation.repoId,
    changeId: attestation.changeId,
    commitSha: attestation.commitSha,
    agentId: attestation.agentId,
    agentVersion: attestation.agentVersion ?? undefined,
    modelName: attestation.modelName ?? undefined,
    modelVersion: attestation.modelVersion ?? undefined,
    promptHash: attestation.promptHash ?? undefined,
    framework: attestation.framework ?? undefined,
    toolsUsed: attestation.toolsUsed as string[],
    testsRun: attestation.testsRun,
    typechecked: attestation.typechecked,
    extra: attestation.extra as Record<string, unknown>,
  });
  try {
    return cryptoVerify(null, Buffer.from(canonical), createPublicKey(key.publicKey), Buffer.from(attestation.signature, "base64"));
  } catch {
    return false;
  }
}

export function hashPrompt(prompt: string): string {
  return "sha256:" + createHash("sha256").update(prompt).digest("hex");
}

export async function listByCommit(db: DB, commitSha: string): Promise<Attestation[]> {
  return db.select().from(attestations).where(eq(attestations.commitSha, commitSha));
}

export async function listByChange(db: DB, changeId: string): Promise<Attestation[]> {
  return db.select().from(attestations).where(eq(attestations.changeId, changeId));
}
