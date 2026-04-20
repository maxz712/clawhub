import { describe, it, expect } from "vitest";
import { DEFAULT_RULES } from "../src/services/sast.js";

describe("DEFAULT_RULES", () => {
  it("detects AWS access keys", () => {
    const rule = DEFAULT_RULES.find(r => r.identifier === "hardcoded-aws-key")!;
    const re = new RegExp(rule.pattern, rule.flags);
    expect(re.test("const key = 'AKIAIOSFODNN7EXAMPLE';")).toBe(true);
    expect(re.test("const key = 'akia_lowercase';")).toBe(false);
  });

  it("detects eval() usage", () => {
    const rule = DEFAULT_RULES.find(r => r.identifier === "js-eval")!;
    const re = new RegExp(rule.pattern, rule.flags);
    expect(re.test("eval('2+2')")).toBe(true);
    expect(re.test("evaluate()")).toBe(false);
  });

  it("detects private-key material", () => {
    const rule = DEFAULT_RULES.find(r => r.identifier === "hardcoded-private-key")!;
    const re = new RegExp(rule.pattern, rule.flags);
    expect(re.test("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(re.test("-----BEGIN CERTIFICATE-----")).toBe(false);
  });

  it("detects md5 usage", () => {
    const rule = DEFAULT_RULES.find(r => r.identifier === "md5-usage")!;
    const re = new RegExp(rule.pattern, rule.flags);
    expect(re.test("crypto.createHash('md5')")).toBe(true);
    expect(re.test("MD5('x')")).toBe(true);
    expect(re.test("sha256('x')")).toBe(false);
  });
});
