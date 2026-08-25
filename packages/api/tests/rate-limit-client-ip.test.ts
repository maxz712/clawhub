import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";

// Security regression (#159): clientIp is the sole bucket key for every per-IP
// limiter (auth/api/git/llm). It used to return client-supplied CF-Connecting-IP
// / X-Real-IP UNCONDITIONALLY, so `curl -H "X-Real-IP: $RANDOM"` minted a fresh
// bucket per request and every limit was decorative. The only gated resolver
// (XFF via CLAWHUB_TRUSTED_PROXY_COUNT) was dead because no deployment set it.
// The fix: default to the non-forgeable socket peer, honour headers ONLY when a
// trusted edge is declared.

// Control the socket peer so we can assert it, not a real node socket.
const connInfo = { remote: { address: "" as string | undefined } };
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => connInfo,
}));

import { clientIp } from "../src/middleware/rate-limit-redis.js";

function ctx(headers: Record<string, string>): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { req: { header: (n: string) => lower[n.toLowerCase()] } } as unknown as Context;
}

beforeEach(() => {
  delete process.env.CLAWHUB_TRUSTED_PROXY_COUNT;
  delete process.env.CLAWHUB_TRUSTED_PROXY_HEADER;
  connInfo.remote.address = "198.51.100.7"; // a stand-in socket peer
});

describe("clientIp — no trusted-proxy config (the default self-host)", () => {
  it("ignores a spoofed X-Real-IP and buckets by the socket peer", () => {
    expect(clientIp(ctx({ "x-real-ip": "10.0.0.99" }))).toBe("198.51.100.7");
  });
  it("ignores a spoofed CF-Connecting-IP", () => {
    expect(clientIp(ctx({ "cf-connecting-ip": "10.0.0.99" }))).toBe("198.51.100.7");
  });
  it("ignores a spoofed X-Forwarded-For", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "10.0.0.99, 172.16.0.1" }))).toBe("198.51.100.7");
  });
  it("gives two distinct peers distinct buckets (never one shared constant)", () => {
    const a = clientIp(ctx({}));
    connInfo.remote.address = "203.0.113.55";
    const b = clientIp(ctx({}));
    expect(a).not.toBe(b);
  });
  it("falls back to 'anon' only when there is no socket info at all", () => {
    connInfo.remote.address = undefined;
    expect(clientIp(ctx({ "x-real-ip": "10.0.0.99" }))).toBe("anon");
  });
});

describe("clientIp — trusted-proxy config honoured", () => {
  it("reads the client from the XFF chain COUNT entries from the right", () => {
    process.env.CLAWHUB_TRUSTED_PROXY_COUNT = "1";
    // Caddy (1 hop) appends the true client; a leftmost spoof is ignored.
    expect(clientIp(ctx({ "x-forwarded-for": "1.2.3.4(spoof), 203.0.113.10" }))).toBe("203.0.113.10");
  });
  it("honours an explicitly-named trusted header (e.g. cf-connecting-ip)", () => {
    process.env.CLAWHUB_TRUSTED_PROXY_COUNT = "1";
    process.env.CLAWHUB_TRUSTED_PROXY_HEADER = "cf-connecting-ip";
    expect(clientIp(ctx({ "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "9.9.9.9" }))).toBe("203.0.113.10");
  });
  it("falls back to the socket peer when the declared header is absent", () => {
    process.env.CLAWHUB_TRUSTED_PROXY_COUNT = "1";
    expect(clientIp(ctx({}))).toBe("198.51.100.7");
  });
});
