import { describe, it, expect, afterEach } from "vitest";
import { evaluateCoverage, normalizeChecks, normalizeDivergence, type VerificationCheck } from "../src/services/verification.js";

const chk = (kind: VerificationCheck["kind"], ok = true, evidenceUrl?: string): VerificationCheck => ({ kind, name: `${kind} check`, ok, evidenceUrl });
const CID = "11111111-1111-1111-1111-111111111111";
const shot = [`https://x/api/v1/repos/n/r/changes/${CID}/evidence/abc.png`];

describe("evaluateCoverage — tier-vs-coverage guard (must-fix #4)", () => {
  it("static tier: only cli checks count; a ui/api claim is dropped", () => {
    const r = evaluateCoverage([chk("cli"), chk("ui"), chk("api")], "static", CID, shot);
    expect(r.status).toBe("success");           // the cli check carries it
    expect(r.observedCoverage).toEqual(["cli"]); // ui/api not observable at static
  });
  it("static tier with ONLY a ui claim (no cli) → failure (lazy run can't pass)", () => {
    const r = evaluateCoverage([chk("ui")], "static", CID, shot);
    expect(r.status).toBe("failure");
  });
  it("app tier: a ui check needs an uploaded screenshot for THIS change", () => {
    expect(evaluateCoverage([chk("ui")], "app", CID, shot).status).toBe("success");
    expect(evaluateCoverage([chk("ui")], "app", CID, []).status).toBe("failure");   // no evidence → inconclusive
  });
  it("app tier: a ui evidenceUrl for ANOTHER change does not count", () => {
    const wrong = ["https://x/api/v1/repos/n/r/changes/99999999-9999-9999-9999-999999999999/evidence/z.png"];
    expect(evaluateCoverage([chk("ui")], "app", CID, wrong).status).toBe("failure");
  });
  it("app tier: an api check is observable (real exercise of the app)", () => {
    expect(evaluateCoverage([chk("api")], "services", CID, []).status).toBe("success");
  });
  it("any FAILED check sinks the attestation regardless of tier", () => {
    expect(evaluateCoverage([chk("api"), chk("cli", false)], "services", CID, []).status).toBe("failure");
  });
  it("behavioral tier with ONLY a cli check (no app exercised) → failure (insufficient coverage)", () => {
    // booted an app but only ran a command and never hit api/ui — not real e2e
    expect(evaluateCoverage([chk("cli")], "app", CID, []).status).toBe("failure");
  });
  it("null tier (legacy) is treated as behavioral", () => {
    expect(evaluateCoverage([chk("api")], null, CID, []).status).toBe("success");
    expect(evaluateCoverage([chk("ui")], null, CID, shot).status).toBe("success");
  });
  it("a ui evidenceUrl carried on the check itself also counts", () => {
    expect(evaluateCoverage([chk("ui", true, shot[0])], "app", CID, []).status).toBe("success");
  });
});

describe("evaluateCoverage — widened claims taxonomy (M5)", () => {
  afterEach(() => { delete process.env.CLAWHUB_STRICT_CLAIMS; });
  const script = (ok = true, extra: Partial<VerificationCheck> = {}): VerificationCheck => ({ kind: "script", name: "npm test", ok, ...extra });
  const apiT = (observed?: string): VerificationCheck => ({ kind: "api", name: "GET /x", ok: true, observed });

  it("config/migration are RESERVED and never observable", () => {
    const r = evaluateCoverage([{ kind: "config", name: "env", ok: true }, { kind: "migration", name: "m", ok: true }], "app", CID, []);
    expect(r.status).toBe("failure");
    expect(r.observedCoverage).toEqual([]);
  });
  it("a script check is corroboration but not app-behavior coverage on its own", () => {
    const r = evaluateCoverage([script()], "app", CID, []);
    expect(r.status).toBe("failure");
    expect(r.observedCoverage).toContain("script");
  });
  it("STRICT: a script check needs command + exitCode 0 + transcript", () => {
    process.env.CLAWHUB_STRICT_CLAIMS = "1";
    const bad = evaluateCoverage([script(true, { command: "npm test" }), apiT("200")], "app", CID, []);
    expect(bad.observedCoverage).not.toContain("script");
    const good = evaluateCoverage([script(true, { command: "npm test", exitCode: 0, observed: "12 passing" }), apiT("200")], "app", CID, []);
    expect(good.observedCoverage).toContain("script");
  });
  it("STRICT: an api check needs a transcript", () => {
    process.env.CLAWHUB_STRICT_CLAIMS = "1";
    expect(evaluateCoverage([apiT()], "app", CID, []).status).toBe("failure");
    expect(evaluateCoverage([apiT("req→res 200")], "app", CID, []).status).toBe("success");
  });
});

describe("normalizeChecks / normalizeDivergence (M5)", () => {
  it("accepts command + exitCode on a script check", () => {
    const [c] = normalizeChecks([{ kind: "script", name: "test", ok: true, command: "npm test", exitCode: 0 }]);
    expect(c.command).toBe("npm test");
    expect(c.exitCode).toBe(0);
  });
  it("rejects an unknown kind", () => {
    expect(() => normalizeChecks([{ kind: "telepathy", name: "x", ok: true }])).toThrow();
  });
  it("normalizes divergence and drops empty descriptions", () => {
    const d = normalizeDivergence({ undeclared: [{ path: "src/x.ts", description: "logs PII" }, { description: "" }] });
    expect(d.undeclared).toHaveLength(1);
    expect(d.undeclared[0].path).toBe("src/x.ts");
  });
  it("returns empty divergence for garbage", () => {
    expect(normalizeDivergence(null).undeclared).toEqual([]);
  });
});
