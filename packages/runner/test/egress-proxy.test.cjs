"use strict";
// Security tests for the egress proxy — the network containment boundary. Run:
//   node --test packages/runner/test/egress-proxy.test.cjs
// Pure decision tests need no network; the integration test spawns the real
// proxy and proves a tunnel is allowed for infra and REFUSED for a private IP
// even under the most-open policy.

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");

const { isPrivateIp, matchOne, decide } = require("../egress-proxy.cjs");

test("isPrivateIp blocks every non-internet range", () => {
  for (const ip of [
    "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.1", "192.168.1.1",
    "127.0.0.1", "0.0.0.0", "169.254.0.1", "169.254.169.254", // <- cloud metadata
    "100.64.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:10.0.0.1",
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} must be private`);
  }
});

test("isPrivateIp allows real public addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} must be public`);
  }
});

test("isPrivateIp fails closed on garbage", () => {
  for (const ip of ["", "not-an-ip", "999.1.1.1"]) assert.equal(isPrivateIp(ip), true);
});

test("matchOne: exact, bare-domain-covers-subdomain, .suffix, *.suffix", () => {
  assert.equal(matchOne("example.com", "example.com"), true);
  assert.equal(matchOne("api.example.com", "example.com"), true);   // bare domain covers subs
  assert.equal(matchOne("api.example.com", ".example.com"), true);
  assert.equal(matchOne("api.example.com", "*.example.com"), true);
  assert.equal(matchOne("example.com", "*.example.com"), true);     // apex matches too
  assert.equal(matchOne("evil-example.com", "example.com"), false); // not a subdomain
  assert.equal(matchOne("example.com.evil.com", "example.com"), false);
});

test("policy=none: only infra reachable, even when infra is a private single-box IP", async () => {
  const cfg = { policy: "none", allow: [], infra: ["10.0.0.5", "api.useclawhub.com"] };
  assert.deepEqual((await decide("10.0.0.5", 443, cfg)).ok, true);          // infra, private OK
  assert.equal((await decide("api.useclawhub.com", 443, { ...cfg, infra: ["api.useclawhub.com"] })).ok, true);
  const blocked = await decide("8.8.8.8", 443, cfg);                         // public, not infra
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "policy_none");
});

test("policy=all: public reachable, but private/metadata ALWAYS blocked (SSRF guard)", async () => {
  const cfg = { policy: "all", allow: [], infra: [] };
  assert.equal((await decide("8.8.8.8", 443, cfg)).ok, true);                // public OK
  const meta = await decide("169.254.169.254", 80, cfg);                     // metadata
  assert.equal(meta.ok, false);
  assert.equal(meta.reason, "private_ip");
  for (const ip of ["10.1.2.3", "192.168.0.1", "127.0.0.1", "172.20.0.9"]) {
    const r = await decide(ip, 5432, cfg);                                   // e.g. internal Postgres
    assert.equal(r.ok, false, `${ip} must be blocked even under policy=all`);
    assert.equal(r.reason, "private_ip");
  }
});

test("policy=allowlist: only allowlisted public hosts, infra always, everything else blocked", async () => {
  const cfg = { policy: "allowlist", allow: ["8.8.8.8", "staging.example.com"], infra: ["1.1.1.1"] };
  assert.equal((await decide("8.8.8.8", 443, cfg)).why, "allowlist");
  assert.equal((await decide("1.1.1.1", 443, cfg)).why, "infra");
  const nope = await decide("140.82.112.3", 443, cfg);
  assert.equal(nope.ok, false);
  assert.equal(nope.reason, "not_allowlisted");
  // An allowlisted *name* that resolves private and is NOT infra is still blocked.
  assert.equal((await decide("10.9.9.9", 443, { ...cfg, allow: ["10.9.9.9"] })).reason, "private_ip");
});

// --- end-to-end: real proxy process, real TCP tunnel --------------------------
function connectThroughProxy(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, "127.0.0.1", () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = "";
    sock.on("data", d => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n")) {
        const status = Number(buf.split(" ")[1]);
        resolve({ status, sock, buf });
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("proxy connect timeout")), 4000);
  });
}

test("integration: tunnel ALLOWED to infra, REFUSED to a private IP under policy=all", async () => {
  // A local echo server stands in for an allowed upstream.
  const echo = http.createServer((req, res) => res.end("ok"));
  await new Promise(r => echo.listen(0, "127.0.0.1", r));
  const echoPort = echo.address().port;

  // Most-open policy, but 127.0.0.1 is the only infra host allowed to resolve
  // private (a literal IP avoids the localhost→::1/IPv4 ambiguity). Spawn the
  // REAL proxy process on a deterministic port.
  const PORT = 38219;
  const proxy = spawn(process.execPath, [path.join(__dirname, "..", "egress-proxy.cjs")], {
    env: { ...process.env, EGRESS_PORT: String(PORT), EGRESS_POLICY: "all", EGRESS_INFRA: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    let out = "";
    proxy.stdout.on("data", d => { out += d.toString(); if (out.includes('"listening"')) resolve(); });
    proxy.on("error", reject);
    setTimeout(resolve, 1500); // fallback: assume up
  });

  try {
    // Allowed: 127.0.0.1 (infra) → 200 Connection Established + working tunnel.
    const ok = await connectThroughProxy(PORT, `127.0.0.1:${echoPort}`);
    assert.equal(ok.status, 200, "infra host should tunnel");
    ok.sock.destroy();

    // Refused: a private IP, even under policy=all → 403 (the SSRF / lateral guard).
    const refused = await connectThroughProxy(PORT, "10.123.45.67:5432");
    assert.equal(refused.status, 403, "private IP must be refused even under policy=all");
    refused.sock.destroy();
  } finally {
    proxy.kill();
    echo.close();
  }
});
