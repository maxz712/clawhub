import { describe, it, expect } from "vitest";
import { safeRelativePath } from "../src/routes/sso.js";

// The post-login `next` (from a public, attacker-controllable /sso/start
// redirect_to) must never bounce a freshly-signed-in user off-site. These are
// the classic open-redirect bypass vectors.
describe("safeRelativePath (open-redirect guard)", () => {
  it("accepts a plain app-relative path", () => {
    expect(safeRelativePath("/feed")).toBe("/feed");
    expect(safeRelativePath("/orgs/123/fleet")).toBe("/orgs/123/fleet");
  });

  it("rejects empty / null", () => {
    expect(safeRelativePath(null)).toBeNull();
    expect(safeRelativePath(undefined)).toBeNull();
    expect(safeRelativePath("")).toBeNull();
  });

  it("rejects absolute and scheme URLs", () => {
    expect(safeRelativePath("https://evil.com")).toBeNull();
    expect(safeRelativePath("http://evil.com/feed")).toBeNull();
    expect(safeRelativePath("javascript:alert(1)")).toBeNull();
  });

  it("rejects protocol-relative //host", () => {
    expect(safeRelativePath("//evil.com")).toBeNull();
    expect(safeRelativePath("//evil.com/path")).toBeNull();
  });

  it("rejects backslash bypasses (browsers normalize \\ to /)", () => {
    expect(safeRelativePath("/\\evil.com")).toBeNull();
    expect(safeRelativePath("\\/\\/evil.com")).toBeNull();
    expect(safeRelativePath("/path\\..\\evil")).toBeNull();
  });

  it("rejects control-character smuggling", () => {
    expect(safeRelativePath("/\tevil")).toBeNull();
    expect(safeRelativePath("/\nevil")).toBeNull();
    expect(safeRelativePath("/\r//evil")).toBeNull();
  });

  it("rejects a bare slash (no real destination)", () => {
    expect(safeRelativePath("/")).toBeNull();
  });
});
