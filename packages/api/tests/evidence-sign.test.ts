import { describe, it, expect, beforeAll } from "vitest";
import { signEvidence, verifyEvidence, signedEvidenceUrl } from "../src/services/evidence-sign.js";

beforeAll(() => { process.env.CLAWHUB_EVIDENCE_SIGN_KEY = "test-evidence-key"; });

const ref = (over: Partial<{ repoId: string; changeId: string; blobId: string; exp: number }> = {}) => ({
  repoId: "r1", changeId: "c1", blobId: "abc.png", exp: Math.floor(Date.now() / 1000) + 3600, ...over,
});

describe("signEvidence / verifyEvidence", () => {
  it("round-trips a valid, unexpired signature", () => {
    const r = ref();
    expect(verifyEvidence(r, signEvidence(r))).toBe(true);
  });
  it("rejects a tampered blob id (signature bound to the exact blob)", () => {
    const r = ref();
    const sig = signEvidence(r);
    expect(verifyEvidence({ ...r, blobId: "other.png" }, sig)).toBe(false);
  });
  it("rejects an expired signature", () => {
    const r = ref({ exp: Math.floor(Date.now() / 1000) - 1 });
    expect(verifyEvidence(r, signEvidence(r))).toBe(false);
  });
  it("rejects a garbage signature", () => {
    expect(verifyEvidence(ref(), "deadbeef")).toBe(false);
    expect(verifyEvidence(ref(), "")).toBe(false);
  });
});

describe("signedEvidenceUrl", () => {
  it("produces a self-verifying public URL with an expiry", () => {
    const { url, expiresAt } = signedEvidenceUrl("https://api.x.com/", { repoId: "r1", changeId: "c1", blobId: "abc.png" }, 3600);
    expect(url).toContain("/api/v1/public/evidence/r1/c1/abc.png");
    const exp = Number(new URL(url).searchParams.get("exp"));
    const sig = new URL(url).searchParams.get("sig")!;
    expect(verifyEvidence({ repoId: "r1", changeId: "c1", blobId: "abc.png", exp }, sig)).toBe(true);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
