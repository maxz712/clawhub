import { describe, it, expect } from "vitest";
import { isApiHostedBlob } from "./blob-origin";

// No NEXT_PUBLIC_API_URL in the test env, so the API origin is the default
// http://localhost:3000. These vectors FAIL against the pre-#167 substring test,
// which returned true for any string containing the path markers regardless of
// origin — the exfiltration primitive.
describe("isApiHostedBlob", () => {
  it("accepts a same-origin evidence URL", () => {
    expect(isApiHostedBlob("http://localhost:3000/api/v1/repos/a/b/changes/1/evidence/c.png")).toBe(true);
  });
  it("accepts a same-origin issue-attachment URL", () => {
    expect(isApiHostedBlob("http://localhost:3000/api/v1/repos/a/b/issue-attachments/x.png")).toBe(true);
  });
  it("accepts a relative /api/v1/repos path (resolves to the API origin)", () => {
    expect(isApiHostedBlob("/api/v1/repos/a/b/changes/1/evidence/c.png")).toBe(true);
  });
  it("rejects an off-origin URL that contains the path markers", () => {
    expect(isApiHostedBlob("https://evil.tld/api/v1/repos/a/b/evidence/c.png")).toBe(false);
  });
  it("rejects a suffix-confusion host", () => {
    expect(isApiHostedBlob("https://localhost:3000.evil.tld/api/v1/repos/a/b/evidence/c.png")).toBe(false);
  });
  it("rejects markers smuggled into the query string on our own origin", () => {
    expect(isApiHostedBlob("http://localhost:3000/x?u=/api/v1/repos/a/b/evidence/")).toBe(false);
  });
  it("does not throw on garbage input", () => {
    expect(isApiHostedBlob("not a url")).toBe(false);
    expect(isApiHostedBlob("")).toBe(false);
  });
});
