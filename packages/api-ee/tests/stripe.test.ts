import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyStripeSignature } from "../src/services/stripe.js";

describe("verifyStripeSignature", () => {
  it("accepts a correctly-signed payload", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const body = JSON.stringify({ id: "evt_123", type: "customer.subscription.updated" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac("sha256", "whsec_test").update(`${ts}.${body}`).digest("hex");
    expect(verifyStripeSignature(`t=${ts},v1=${sig}`, body)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const body = JSON.stringify({ id: "evt_123" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac("sha256", "whsec_test").update(`${ts}.${body}_tampered`).digest("hex");
    expect(verifyStripeSignature(`t=${ts},v1=${sig}`, body)).toBe(false);
  });

  it("rejects when secret unset", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "";
    expect(verifyStripeSignature("t=1,v1=abc", "{}")).toBe(false);
  });
});
