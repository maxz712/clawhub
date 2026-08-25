import { describe, it, expect, vi, beforeEach } from "vitest";

// Security regression (#207): url-guard is the API process's single SSRF control
// for outbound fetches to caller-supplied hosts. Three defects, all covered here:
//   1. resolve-and-discard — the vetted address was thrown away and every caller
//      re-resolved the hostname, opening a DNS-rebind window. The fix returns the
//      PINNED address (resolvePublicHttpTarget) so the vetted address is the one
//      connected to.
//   2. the IPv6 branch was a DENYLIST that missed live internal space
//      (::169.254.169.254, 64:ff9b::/96 NAT64, 2002::/16 6to4). The fix is the
//      egress-proxy #131 classifier: canonical byte expansion + a 2000::/3
//      allowlist, so anything outside global unicast fails closed.
//   3. IPv6 LITERALS never reached the classifier (URL.hostname keeps the
//      brackets, so isIP() returned 0 and it fell through to lookup(), refused as
//      "could not resolve host" — a bracket accident, not a containment decision).

// A controllable stub for node:dns/promises.lookup.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...a: unknown[]) => lookupMock(...(a as [])),
}));

import { isPrivateIp, ipBlockReason, resolvePublicHttpTarget, assertPublicHttpHost } from "../src/services/url-guard.js";

beforeEach(() => { lookupMock.mockReset(); });

describe("isPrivateIp — canonical classifier (ported from egress-proxy #131)", () => {
  const priv = [
    "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0",
    // IPv6 forms that embed live internal v4 — the denylist gaps #207 named.
    "::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
    "::169.254.169.254",          // IPv4-compatible ::/96
    "64:ff9b::a9fe:a9fe",         // NAT64 64:ff9b::/96 → 169.254.169.254
    "2002:7f00:1::",              // 6to4 2002::/16 → 127.0.0.1
    "fe80::1", "fc00::1",         // link-local / ULA
    "2001:db8::1",               // documentation, inside 2000::/3
    "100::1",                    // discard-only, outside allowlist
  ];
  for (const ip of priv) it(`blocks ${ip}`, () => expect(isPrivateIp(ip)).toBe(true));

  const pub = ["8.8.8.8", "1.1.1.1", "203.0.113.10", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of pub) it(`allows ${ip}`, () => expect(isPrivateIp(ip)).toBe(false));
});

describe("ipBlockReason — every blocked IPv6 form has a containment reason", () => {
  for (const ip of ["::169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:7f00:1::"]) {
    it(`${ip} → reason (not allowed)`, () => {
      const r = ipBlockReason(ip);
      expect(r).toBeTruthy();
      expect(r).not.toContain("could not resolve");
    });
  }
  it("passes a public v6", () => expect(ipBlockReason("2606:4700:4700::1111")).toBeNull());
});

describe("resolvePublicHttpTarget — literals reach the classifier (isIP fix)", () => {
  it("blocks bracketed IPv6 literals with a containment reason, not a resolve error", async () => {
    for (const url of ["http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::169.254.169.254]/"]) {
      const r = await resolvePublicHttpTarget(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).not.toContain("could not resolve");
      // lookup() must NEVER be consulted for an IP literal.
      expect(lookupMock).not.toHaveBeenCalled();
    }
  });

  it("rejects non-http(s) schemes", async () => {
    const r = await resolvePublicHttpTarget("file:///etc/passwd");
    expect(r).toEqual({ ok: false, reason: "only http(s) URLs may be fetched" });
  });
});

describe("resolvePublicHttpTarget — DNS rebind is closed (pin the vetted address)", () => {
  it("returns the PUBLIC address that was vetted, never a later loopback answer", async () => {
    // First call (the guard) answers public; a second resolution would answer
    // loopback — the rebind. The pinned result must carry the public address.
    lookupMock
      .mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const r = await resolvePublicHttpTarget("http://rebind.example/");
    expect(r).toEqual({ ok: true, ip: "203.0.113.10", family: 4 });
  });

  it("blocks when DNS resolves to a private address", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const r = await resolvePublicHttpTarget("http://evil.example/");
    expect(r.ok).toBe(false);
  });

  it("blocks a DNS answer of ::169.254.169.254 (the unit-level case #207 called out first)", async () => {
    lookupMock.mockResolvedValue([{ address: "::169.254.169.254", family: 6 }]);
    const r = await resolvePublicHttpTarget("http://meta.example/");
    expect(r.ok).toBe(false);
    expect(await assertPublicHttpHost("http://meta.example/")).toBeTruthy();
  });
});
