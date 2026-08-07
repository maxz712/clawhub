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

const { isPrivateIp, matchOne, splitHostPort, decide } = require("../egress-proxy.cjs");

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

// #131 leg 1: the guard used to decide on the SPELLING of the address, so every
// alternate spelling of loopback/metadata read as "public internet" — and WHATWG
// `URL` re-serializes the one spelling that WAS caught into one that was not.
test("isPrivateIp blocks EVERY spelling of an embedded private v4 (#131)", () => {
  for (const ip of [
    "::ffff:7f00:1",        // = 127.0.0.1, the hex form `URL` produces
    "::ffff:a9fe:a9fe",     // = 169.254.169.254 cloud metadata
    "::ffff:ac11:1",        // = 172.17.0.1 docker bridge gateway / the host
    "::ffff:c0a8:101",      // = 192.168.1.1
    "::ffff:0a00:1",        // = 10.0.0.1
    "::ffff:0:7f00:1",      // IPv4-translated ::ffff:0:0:0/96
    "::ffff:0:a9fe:a9fe",   // IPv4-translated metadata
    "0:0:0:0:0:0:0:1",      // fully expanded loopback
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "0:0:0:ffff::7f00:1",   // reserved ::/8 space, embeds loopback
    "::7f00:1",             // IPv4-compatible (deprecated) loopback
    "2002:7f00:1::",        // 6to4 embedding 127.0.0.1
    "2002:a9fe:a9fe::1",    // 6to4 embedding cloud metadata
    "64:ff9b::a9fe:a9fe",   // NAT64 embedding cloud metadata
    "64:ff9b::169.254.169.254",
    "64:ff9b:1::a9fe:a9fe", // NAT64 local-use prefix (variable embedding → refuse)
    "100::1",               // discard-only
    "2001:db8::1",          // documentation (RFC 3849)
    "3fff::1", "3fff:0fff:ffff::1", // documentation 3fff::/20 (RFC 9637) — inside 2000::/3
    "2001::1",              // Teredo
    "[::ffff:7f00:1]",      // bracketed literal, as CONNECT/URL hand it over
    "fe80::1%eth0",         // zone id
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} must be private`);
  }
});

test("isPrivateIp allows real public addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} must be public`);
  }
});

// The fix must not be "block anything that looks v4-mapped" — a mapped PUBLIC v4
// is a legitimate destination and dual-stack resolvers hand them out routinely.
test("isPrivateIp keeps mapped/6to4 PUBLIC addresses reachable", () => {
  for (const ip of [
    "::ffff:8.8.8.8", "::ffff:808:808", "::ffff:0:808:808",
    "2002:808:808::1",              // 6to4 embedding 8.8.8.8
    "64:ff9b::8.8.8.8", "64:ff9b::808:808", // NAT64 embedding 8.8.8.8 — a DNS64-only
                                    // host reaches the whole v4 internet this way
    "2a00:1450:4001:80f::200e",     // google v6
    "2000::1", "3ffe::1",           // the edges of global unicast 2000::/3
    "3fff:1000::1",                 // just OUTSIDE the /20 documentation prefix
  ]) {
    assert.equal(isPrivateIp(ip), false, `${ip} must be public`);
  }
});

test("isPrivateIp fails closed on garbage", () => {
  for (const ip of ["", "not-an-ip", "999.1.1.1", "::ffff:999.1.1.1", ":::1", "1:2:3", "0x7f000001"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} must fail closed`);
  }
});

// CONNECT targets are `host:port`, and an IPv6 host is BRACKETED. Splitting on
// ":" yielded `"["` — every IPv6 CONNECT failed as `no_host`, which accidentally
// masked leg 1 over TLS. Parsing must land together with the guard fix, never
// before it, or the hole widens from plain HTTP to arbitrary TCP.
test("splitHostPort handles bracketed IPv6, bare hosts, and a missing port", () => {
  assert.deepEqual(splitHostPort("example.com:443", 443), { host: "example.com", port: 443 });
  assert.deepEqual(splitHostPort("example.com", 443), { host: "example.com", port: 443 });
  assert.deepEqual(splitHostPort("10.0.0.1:5432", 443), { host: "10.0.0.1", port: 5432 });
  assert.deepEqual(splitHostPort("[::ffff:7f00:1]:8080", 443), { host: "::ffff:7f00:1", port: 8080 });
  assert.deepEqual(splitHostPort("[2606:4700:4700::1111]:443", 443), { host: "2606:4700:4700::1111", port: 443 });
  assert.deepEqual(splitHostPort("[::1]", 443), { host: "::1", port: 443 });
  assert.deepEqual(splitHostPort("::1", 443), { host: "::1", port: 443 }); // unbracketed: no separable port
  assert.deepEqual(splitHostPort("", 443), { host: "", port: 443 });
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
  // Infra by NAME (not literal) resolves and is still admitted. `localhost` stands
  // in for the API's hostname so the suite needs no DNS — it resolves from
  // /etc/hosts to a private address, which is exactly the case infra exists for.
  assert.equal((await decide("localhost", 443, { ...cfg, infra: ["localhost"] })).ok, true);
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

test("decide: a bracketed public IPv6 literal is reachable under policy=all", async () => {
  const r = await decide("[2606:4700:4700::1111]", 443, { policy: "all", allow: [], infra: [] });
  assert.equal(r.ok, true);
  assert.equal(r.why, "policy_all");
});

// #131 leg 2: soft infra is reachable under EVERY policy (so a BYO agent's custom
// gateway still works under egress:none) but is NOT exempt from the private-IP
// guard — that exemption stays with operator-derived hard infra only.
test("soft infra: policy-exempt but STILL private-IP guarded", async () => {
  const cfg = { policy: "none", allow: [], infra: ["10.0.0.5"], softInfra: ["gw.example.com", "169.254.169.254", "127.0.0.1"] };
  // Hard infra: private and exempt (the single-box self-host case).
  assert.equal((await decide("10.0.0.5", 443, cfg)).why, "infra");
  // Soft infra on a public address: reachable even under policy=none.
  const soft = await decide("8.8.8.8", 443, { ...cfg, softInfra: ["8.8.8.8"] });
  assert.equal(soft.ok, true);
  assert.equal(soft.why, "soft_infra");
  // Soft infra pointed at metadata / loopback: refused, in every mode.
  for (const policy of ["none", "allowlist", "all"]) {
    for (const host of ["169.254.169.254", "127.0.0.1"]) {
      const r = await decide(host, 80, { ...cfg, policy });
      assert.equal(r.ok, false, `${host} under ${policy} must be refused`);
      assert.equal(r.reason, "private_ip");
    }
  }
  // And the hex spelling of the same thing does not sneak past either.
  assert.equal((await decide("[::ffff:a9fe:a9fe]", 80, { ...cfg, policy: "all" })).reason, "private_ip");
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

/** Absolute-form plain-HTTP proxying: `GET http://host:port/` through the proxy. */
function getThroughProxy(proxyPort, absoluteUrl) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: absoluteUrl,
      headers: { host: new URL(absoluteUrl).host } }, res => {
      let body = "";
      res.on("data", d => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, reason: res.headers["x-egress-reason"], body }));
    });
    req.on("error", reject);
    req.end();
    setTimeout(() => reject(new Error("proxy http timeout")), 4000);
  });
}

async function spawnProxy(port, env) {
  const proxy = spawn(process.execPath, [path.join(__dirname, "..", "egress-proxy.cjs")], {
    env: { ...process.env, EGRESS_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    let out = "";
    proxy.stdout.on("data", d => { out += d.toString(); if (out.includes('"listening"')) resolve(); });
    proxy.on("error", reject);
    setTimeout(resolve, 1500);
  });
  return proxy;
}

// The end-to-end proof for #131: a victim on loopback, the REAL proxy at its most
// open policy, and the hex spelling of 127.0.0.1. On the pre-fix code this test
// returns 200 with the victim's body (the bypass); it must return 403 private_ip.
test("integration: hex-form IPv4-mapped loopback is REFUSED over HTTP and CONNECT under policy=all", async () => {
  const victim = http.createServer((_req, res) => res.end("SECRET-INTERNAL-DATA"));
  await new Promise(r => victim.listen(0, "127.0.0.1", r));
  const victimPort = victim.address().port;

  const PORT = 38221;
  const proxy = await spawnProxy(PORT, { EGRESS_POLICY: "all", EGRESS_INFRA: "", EGRESS_SOFT_INFRA: "" });
  try {
    for (const host of ["[::ffff:7f00:1]", "[::ffff:0:7f00:1]", "[::ffff:127.0.0.1]", "[0:0:0:0:0:0:0:1]", "127.0.0.1"]) {
      const r = await getThroughProxy(PORT, `http://${host}:${victimPort}/`);
      assert.equal(r.status, 403, `${host} must be refused (got ${r.status} ${r.body})`);
      assert.equal(r.reason, "private_ip", `${host} must be refused as private_ip`);
      assert.ok(!r.body.includes("SECRET"), `${host} must not reach the victim`);
    }
    // CONNECT must refuse for the SAME reason — `no_host` would mean the bracketed
    // literal never even reached the guard (the accidental immunity, not a fix).
    const tunnel = await connectThroughProxy(PORT, `[::ffff:7f00:1]:${victimPort}`);
    assert.equal(tunnel.status, 403);
    assert.match(tunnel.buf, /X-Egress-Reason: private_ip/i);
    tunnel.sock.destroy();
  } finally {
    proxy.kill();
    victim.close();
  }
});

// The parsing fix must not block legitimate bracketed IPv6 traffic. `::1` stands
// in for a public v6 literal by being listed as operator infra (the one tier that
// may be private), which exercises the exact same bracket-parsing path.
test("integration: CONNECT to a bracketed IPv6 literal tunnels when permitted", async t => {
  const echo = http.createServer((_req, res) => res.end("ok"));
  const bound = await new Promise(r => {
    echo.once("error", () => r(false));
    echo.listen(0, "::1", () => r(true));
  });
  if (!bound) return t.skip("no IPv6 loopback in this environment");
  const echoPort = echo.address().port;

  const PORT = 38222;
  const proxy = await spawnProxy(PORT, { EGRESS_POLICY: "none", EGRESS_INFRA: "::1" });
  try {
    const ok = await connectThroughProxy(PORT, `[::1]:${echoPort}`);
    assert.equal(ok.status, 200, "a bracketed IPv6 infra host must tunnel, not fail as no_host");
    ok.sock.destroy();
  } finally {
    proxy.kill();
    echo.close();
  }
});
