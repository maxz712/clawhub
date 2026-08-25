import { describe, it, expect } from "vitest";
import { recordVerification, resolveVerifiedEvidence } from "../src/services/verification.js";
import { ciRuns, standingAgents, changes, verificationRuns } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

// #155 — the tier-vs-coverage guard's `ui` leg used to validate a claim against a
// CLIENT-SUPPLIED STRING: `evidence:["/changes/<cid>/evidence/x.png"]` (or a
// hallucinated `checks[].evidenceUrl`) satisfied the substring test with no blob
// ever uploaded, minting a success attestation that substitutes for the human
// code-review slot under verified autonomy. recordVerification now resolves every
// claimed URL against the evidence STORE, keyed by the SERVER's repoId+changeId.

const REPO = "repo1";
const CID = "chg1";
const HEAD = "abc123";
const BLOB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
const mintedUrl = (blob: string, cid = CID) => `https://x/api/v1/repos/n/r/changes/${cid}/evidence/${blob}`;

// Same table-aware fake DB as verification.test.ts — drives the guard ladder
// without a Postgres; insert echoes the values back.
function fakeDb(): DB {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const rowsFor = (t: unknown): Record<string, unknown>[] => {
    if (t === ciRuns) return [{ id: "run1", origin: "agent", standingAgentId: "sa1", repoId: REPO, commit: HEAD }];
    if (t === standingAgents) return [{ id: "sa1", agentId: "agentV", mode: "verify" }];
    if (t === changes) return [{ id: CID, repoId: REPO, headCommit: HEAD, openedByAgentId: "agentA", verifyTier: "app" }];
    if (t === verificationRuns) return tables.verificationRuns ?? [];
    return [];
  };
  return {
    select: () => ({
      from: (t: unknown) => {
        const chain = { innerJoin: () => chain, where: () => chain, limit: () => Promise.resolve(rowsFor(t)) };
        return chain;
      },
    }),
    insert: () => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{ id: "vr1", ...vals }]) }),
      }),
    }),
  } as unknown as DB;
}

/** A store that "holds" exactly the given keys. */
const storeWith = (...keys: string[]) => ({ exists: async (k: string) => keys.includes(k) });

const base = { repoId: REPO, changeId: CID, callerAgentId: "agentV", runId: "run1" };
const uiCheck = (evidenceUrl?: string) => ({ kind: "ui" as const, name: "settings page renders", ok: true, evidenceUrl });

describe("resolveVerifiedEvidence — the claim is not its own proof (#155)", () => {
  it("accepts only a URL whose blob actually exists under THIS change's key", async () => {
    const url = mintedUrl(BLOB);
    const ok = await resolveVerifiedEvidence(storeWith(`evidence/${REPO}/${CID}/${BLOB}`), REPO, CID, [url]);
    expect(ok.has(url)).toBe(true);
  });
  it("rejects a URL with no blob behind it", async () => {
    expect((await resolveVerifiedEvidence(storeWith(), REPO, CID, [mintedUrl(BLOB)])).size).toBe(0);
  });
  it("rejects a URL naming ANOTHER change even when that change's blob exists", async () => {
    const other = "99999999-9999-9999-9999-999999999999";
    const ok = await resolveVerifiedEvidence(storeWith(`evidence/${REPO}/${other}/${BLOB}`), REPO, CID, [mintedUrl(BLOB, other)]);
    expect(ok.size).toBe(0);
  });
  it("rejects a non-server-minted trailing segment (hallucinated x.png)", async () => {
    expect((await resolveVerifiedEvidence(storeWith(), REPO, CID, [mintedUrl("x.png")])).size).toBe(0);
  });
  it("no store wired ⇒ nothing verifiable (fails CLOSED, never open)", async () => {
    expect((await resolveVerifiedEvidence(null, REPO, CID, [mintedUrl(BLOB)])).size).toBe(0);
    expect((await resolveVerifiedEvidence(undefined, REPO, CID, [mintedUrl(BLOB)])).size).toBe(0);
  });
  it("the existence check uses the SERVER's repoId, not one parsed from the URL", async () => {
    // Blob exists under a DIFFERENT repo — the same changeId string in the URL
    // must not let it count for this repo's change.
    const ok = await resolveVerifiedEvidence(storeWith(`evidence/OTHER/${CID}/${BLOB}`), REPO, CID, [mintedUrl(BLOB)]);
    expect(ok.size).toBe(0);
  });
});

describe("recordVerification — a forged ui claim never mints a success attestation (#155)", () => {
  it("THE BUG: top-level evidence[] carrying an un-uploaded URL → failure, no ui coverage", async () => {
    const res = await recordVerification(fakeDb(), {
      ...base, checks: [uiCheck()], evidence: [mintedUrl(BLOB)], store: storeWith(),
    });
    expect(res.status).toBe("failure");
  });
  it("THE BUG: a hallucinated checks[].evidenceUrl goes through the same filter → failure", async () => {
    const res = await recordVerification(fakeDb(), {
      ...base, checks: [uiCheck(mintedUrl(BLOB))], evidence: [], store: storeWith(),
    });
    expect(res.status).toBe("failure");
  });
  it("no store wired: a ui claim fails closed", async () => {
    const res = await recordVerification(fakeDb(), {
      ...base, checks: [uiCheck()], evidence: [mintedUrl(BLOB)],
    });
    expect(res.status).toBe("failure");
  });
  it("the legitimate path still passes: a really-uploaded blob backs the ui claim", async () => {
    const res = await recordVerification(fakeDb(), {
      ...base, checks: [uiCheck()], evidence: [mintedUrl(BLOB)],
      store: storeWith(`evidence/${REPO}/${CID}/${BLOB}`),
    });
    expect(res.status).toBe("success");
  });
  it("a really-uploaded blob carried on the check itself also still counts", async () => {
    const res = await recordVerification(fakeDb(), {
      ...base, checks: [uiCheck(mintedUrl(BLOB))], evidence: [],
      store: storeWith(`evidence/${REPO}/${CID}/${BLOB}`),
    });
    expect(res.status).toBe("success");
  });
  it("non-ui legs are unchanged: an api check needs no evidence (non-strict)", async () => {
    const res = await recordVerification(fakeDb(), {
      ...base, checks: [{ kind: "api" as const, name: "GET /health → 200", ok: true }], store: storeWith(),
    });
    expect(res.status).toBe("success");
  });
});
