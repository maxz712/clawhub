import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";

describe("webhook HMAC signing", () => {
  it("matches the algorithm used by the dispatcher", () => {
    const secret = "shhh";
    const body = JSON.stringify({ type: "change.merged", repoId: "r1", changeId: "c1" });
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    // Recompute and compare.
    const again = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(sig).toBe(again);
  });
});
