import { describe, it, expect } from "vitest";
import { sanitizeEgressHosts, validateStandingConfig, VALID_EGRESS } from "../src/services/standing-agents.js";
import { ValidationError } from "../src/services/errors.js";

// The egress allowlist is a security control: a malformed or over-long entry must
// fail loudly, never silently widen (or quietly drop, changing what the agent can
// reach). These tests pin that contract for the per-run egress proxy.

describe("sanitizeEgressHosts", () => {
  it("accepts plain hosts, subdomains, and wildcard/suffix forms", () => {
    expect(sanitizeEgressHosts(["example.com", "api.example.com", "*.test.dev", ".staging.io"]))
      .toEqual(["example.com", "api.example.com", "*.test.dev", ".staging.io"]);
  });

  it("accepts a comma/space separated string", () => {
    expect(sanitizeEgressHosts("a.com, b.com  c.com")).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("lowercases, dedupes, and strips port/path/scheme from pasted URLs", () => {
    expect(sanitizeEgressHosts(["HTTPS://API.Example.com/v1?x=1", "api.example.com:443"]))
      .toEqual(["api.example.com"]);
  });

  it("accepts literal IPs (for fixed upstreams)", () => {
    expect(sanitizeEgressHosts(["140.82.112.3"])).toEqual(["140.82.112.3"]);
  });

  it("rejects garbage hosts", () => {
    for (const bad of ["has space.com", "under_score.com", "bad!.com", "a..b.com"]) {
      expect(() => sanitizeEgressHosts([bad]), bad).toThrow(ValidationError);
    }
  });

  it("rejects an over-long list", () => {
    const many = Array.from({ length: 101 }, (_, i) => `h${i}.example.com`);
    expect(() => sanitizeEgressHosts(many)).toThrow(ValidationError);
  });

  it("ignores blanks", () => {
    expect(sanitizeEgressHosts(["", "  ", "example.com"])).toEqual(["example.com"]);
  });
});

describe("validateStandingConfig egress policy", () => {
  it("accepts the three policies", () => {
    for (const p of VALID_EGRESS) expect(() => validateStandingConfig({ egressPolicy: p })).not.toThrow();
  });
  it("rejects an unknown policy", () => {
    expect(() => validateStandingConfig({ egressPolicy: "open" })).toThrow(ValidationError);
    expect(() => validateStandingConfig({ egressPolicy: "bridge" })).toThrow(ValidationError);
  });
  it("leaves egress unchecked when not provided (back-compat)", () => {
    expect(() => validateStandingConfig({ name: "ok" })).not.toThrow();
  });
});
