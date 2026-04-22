import { createHash } from "node:crypto";
import type { KeyProvider } from "./kms.js";

export interface SignedArtifact {
  name: string;
  url: string;
  sha256: string;
  signature: string;
  keyId: string;
}

export async function signArtifact(kms: KeyProvider, input: { name: string; url: string; content: Buffer }): Promise<SignedArtifact> {
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  const message = `clawhub-artifact-v1\n${input.name}\nsha256:${sha256}\n`;
  const { signature, keyId } = await kms.sign(new TextEncoder().encode(message));
  return { name: input.name, url: input.url, sha256, signature, keyId };
}

export async function verifyArtifact(kms: KeyProvider, sig: SignedArtifact, content: Buffer): Promise<boolean> {
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (sha256 !== sig.sha256) return false;
  const message = `clawhub-artifact-v1\n${sig.name}\nsha256:${sig.sha256}\n`;
  return kms.verify(new TextEncoder().encode(message), sig.signature, sig.keyId);
}
