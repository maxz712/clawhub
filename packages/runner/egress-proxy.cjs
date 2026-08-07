#!/usr/bin/env node
/**
 * ClawHub egress proxy — the network containment boundary for a sandboxed agent
 * run. It is a forward HTTP/HTTPS proxy (plain `http`/`net`, zero deps) that the
 * runner stands up in its OWN container, dual-homed: the agent container reaches
 * it over a `--internal` Docker network (no route to the internet of its own),
 * and the proxy is the ONLY way out. Every connection is allow/deny-decided here.
 *
 * Why this exists: an agent that can open a browser and reach the internet must
 * not be able to harm anything but its own sandbox. This proxy is the physical
 * choke point — if the agent ignores the proxy and opens a raw socket, the
 * internal network has no default route and the connection fails closed.
 *
 * Decision policy (env-driven, set by the runner):
 *   EGRESS_POLICY = none | allowlist | all
 *     none      → only the infra hosts (ClawHub API/git + the LLM endpoint) are
 *                 reachable. The agent can still get its issue + push code, and
 *                 the browser can hit the in-sandbox app on localhost, but it
 *                 reaches NOTHING else on the internet.
 *     allowlist → infra hosts PLUS the operator's EGRESS_ALLOW host patterns.
 *     all       → any PUBLIC host. Private/internal ranges stay blocked.
 *   EGRESS_ALLOW = comma-separated host patterns (exact, `.suffix`, or `*.suffix`)
 *   EGRESS_INFRA = comma-separated infra hosts always reachable, even if they
 *                  resolve to a private IP (a single-box self-host serves the API
 *                  from a private address). These are OPERATOR-trusted, derived
 *                  ONLY from the runner's own config — never from the run payload
 *                  or the repo's secrets (see infra-hosts.cjs).
 *   EGRESS_SOFT_INFRA = comma-separated hosts reachable under EVERY policy (like
 *                  infra) but STILL subject to the private-IP guard. This is where
 *                  anything derived from tenant-controlled input lives (a repo
 *                  secret's `*_BASE_URL`, the well-known LLM provider domains): a
 *                  BYO agent's gateway keeps working under `egress: none`, but a
 *                  tenant cannot name a secret `X_BASE_URL=http://169.254.169.254`
 *                  and thereby exempt itself from the guard (#131 leg 2).
 *
 * Hard invariant, enforced in EVERY mode (including `all`): a connection whose
 * resolved address is private / loopback / link-local / unique-local / CGNAT /
 * cloud-metadata is REFUSED unless the host is an explicit operator infra host.
 * This is the SSRF / lateral-movement guard — "open to the internet" never means
 * "open to the Postgres on the same box" or "open to 169.254.169.254".
 *
 * The resolved IP is PINNED: we resolve once and connect to that exact address,
 * so a host can't pass the check and then DNS-rebind to a private target.
 *
 * Every decision is logged to stdout as one JSON line, so the run log carries an
 * auditable record of exactly what the agent reached and what was blocked.
 */

"use strict";

const http = require("node:http");
const net = require("node:net");
const dns = require("node:dns").promises;

const PORT = Number(process.env.EGRESS_PORT || 8080);
const splitHosts = s => String(s || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
const ENV_CFG = {
  policy: (process.env.EGRESS_POLICY || "none").toLowerCase(),
  allow: splitHosts(process.env.EGRESS_ALLOW),
  infra: splitHosts(process.env.EGRESS_INFRA),
  softInfra: splitHosts(process.env.EGRESS_SOFT_INFRA),
};

function logDecision(o) {
  try { process.stdout.write(JSON.stringify({ t: "egress", ...o }) + "\n"); } catch { /* ignore */ }
}

/** Does `host` match a single allow/infra pattern? Supports exact, `.suffix`, `*.suffix`. */
function matchOne(host, pattern) {
  if (!pattern) return false;
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
  if (pattern.startsWith(".")) return host.endsWith(pattern) || host === pattern.slice(1);
  // bare domain also matches its subdomains, so `example.com` covers `api.example.com`
  return host === pattern || host.endsWith("." + pattern);
}
const matchAny = (host, list) => list.some(p => matchOne(host, p));

/** Is a dotted-quad IPv4 string outside the public internet? */
function isPrivateV4(s) {
  const p = s.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                 // 0.0.0.0/8 "this host"
  if (a === 10) return true;                // 10/8
  if (a === 127) return true;               // loopback
  if (a === 169 && b === 254) return true;  // link-local + 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;  // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true;                // multicast / reserved / broadcast
  return false;
}

/**
 * Expand ANY spelling of an IPv6 address to its canonical 16 bytes — `::`
 * compression, a trailing dotted quad, an expanded 8-group form. Returns null if
 * it does not parse (callers must then fail closed).
 *
 * This exists because deciding on the STRING is what broke containment (#131):
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address, and WHATWG `URL`
 * re-serializes the first into the second — so a spelling-based guard is bypassed
 * by simply writing the address the other way. Normalize, then decide.
 */
function ipv6Bytes(str) {
  let s = String(str).toLowerCase();
  // A trailing dotted quad (`::ffff:127.0.0.1`) → rewrite as two hex groups.
  const quad = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (quad) {
    const p = quad[2].split(".").map(Number);
    if (p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${quad[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let groups;
  if (tail === null) groups = head;
  else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  const b = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    b[i * 2] = v >> 8;
    b[i * 2 + 1] = v & 0xff;
  }
  return b;
}

const zeroRun = (b, from, to) => { for (let i = from; i < to; i++) if (b[i] !== 0) return false; return true; };
const v4At = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

/**
 * Parse an IPv4/IPv6 string and decide if it is a private / non-internet address.
 *
 * IPv6 is decided as an ALLOWLIST of what is public, not a denylist of prefixes:
 * global unicast is `2000::/3` and nothing else is a reachable internet address,
 * so every current and FUTURE special-purpose range outside it (`100::/64`
 * discard, `64:ff9b:1::/48`, whatever IANA assigns next) fails closed by default
 * instead of being silently "public". The two documentation prefixes that DO sit
 * inside `2000::/3` (`2001:db8::/32`, `3fff::/20`) plus Teredo are refused
 * explicitly. Any form that EMBEDS an IPv4 address (v4-mapped, v4-translated,
 * v4-compatible, 6to4, NAT64 `64:ff9b::/96`) is handed to the v4 range table, so
 * the embedded address decides — a mapped PUBLIC v4 (`::ffff:8.8.8.8`) stays
 * reachable, a mapped private one does not.
 */
function isPrivateIp(ip) {
  if (!ip) return true;
  // Tolerate a bracketed literal and a zone id (`[fe80::1%eth0]`).
  let s = String(ip).trim().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (net.isIPv4(s)) return isPrivateV4(s);
  if (net.isIPv6(s)) {
    const b = ipv6Bytes(s);
    if (!b) return true; // parsed by node but not by us → fail closed
    // IPv4-mapped ::ffff:0:0/96 and IPv4-translated ::ffff:0:0:0/96.
    if (zeroRun(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(v4At(b, 12));
    if (zeroRun(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && zeroRun(b, 10, 12)) return isPrivateV4(v4At(b, 12));
    // IPv4-compatible ::a.b.c.d (deprecated) — covers ::1 and :: as 0.0.0.x too.
    if (zeroRun(b, 0, 12)) return isPrivateV4(v4At(b, 12));
    // 6to4 2002::/16 embeds the v4 of the relay/host in bytes 2..5.
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(v4At(b, 2));
    // NAT64 well-known prefix 64:ff9b::/96 embeds the v4 in the last 32 bits. A
    // DNS64/NAT64-only host reaches the whole v4 internet through it, so decide on
    // the embedded address rather than refusing the prefix outright. (The local-use
    // 64:ff9b:1::/48 prefix has a variable embedding and stays refused below.)
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeroRun(b, 4, 12)) return isPrivateV4(v4At(b, 12));
    // Teredo 2001::/32 also embeds v4 (server + obfuscated client) — not a direct
    // internet host for our purposes, so refuse rather than partially decode it.
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;
    // Documentation prefixes, which DO sit inside global unicast: 2001:db8::/32
    // (RFC 3849) and 3fff::/20 (RFC 9637).
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
    if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) return true;
    // Everything outside global unicast 2000::/3 is not a public internet address
    // (link-local fe80::/10, ULA fc00::/7, multicast ff00::/8, and all reserved).
    if ((b[0] & 0xe0) !== 0x20) return true;
    return false;
  }
  return true; // unparseable → fail closed
}

/**
 * Split a CONNECT target (`host:port`) into its parts, handling the BRACKETED
 * IPv6 literal form (`[2606:4700::1111]:443`). Naively splitting on ":" yields
 * `"["` for any IPv6 target, which used to make every such CONNECT fail as
 * `no_host` — an accident that hid the guard's real gap rather than closing it.
 */
function splitHostPort(raw, defaultPort) {
  const s = String(raw || "").trim();
  const bracketed = s.match(/^\[([^\]]*)\](?::(\d+))?$/);
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2] || defaultPort) };
  const colons = (s.match(/:/g) || []).length;
  // A bare IPv6 literal (more than one colon, unbracketed) has no separable port.
  if (colons > 1) return { host: s, port: defaultPort };
  const i = s.lastIndexOf(":");
  if (i < 0) return { host: s, port: defaultPort };
  return { host: s.slice(0, i), port: Number(s.slice(i + 1) || defaultPort) };
}

/**
 * Resolve `host` and decide whether the connection is permitted. Returns the
 * pinned IP to connect to, or a refusal reason. Never throws.
 */
async function decide(host, port, cfg = ENV_CFG) {
  const policy = (cfg.policy || "none").toLowerCase();
  const allow = cfg.allow || [];
  const infraList = cfg.infra || [];
  const softList = cfg.softInfra || [];
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return { ok: false, reason: "no_host" };
  const infra = matchAny(h, infraList);
  const softInfra = !infra && matchAny(h, softList);

  // Resolve to a concrete address and PIN it (anti DNS-rebind).
  let ip;
  // If the host is already a literal IP, use it directly.
  if (net.isIP(h)) ip = h;
  else {
    try { ip = (await dns.lookup(h)).address; }
    catch (e) { return { ok: false, reason: "dns_fail", detail: String(e && e.code || e) }; }
  }

  // Infra hosts are operator-trusted and may legitimately be private (single-box
  // self-host). Everything else — INCLUDING soft infra, which is derived from
  // tenant-controlled input — is subject to the private-range guard in ALL modes.
  if (!infra && isPrivateIp(ip)) return { ok: false, reason: "private_ip", ip };

  if (infra) return { ok: true, ip, why: "infra" };
  if (softInfra) return { ok: true, ip, why: "soft_infra" };
  if (policy === "all") return { ok: true, ip, why: "policy_all" };
  if (matchAny(h, allow)) return { ok: true, ip, why: "allowlist" };
  return { ok: false, reason: policy === "none" ? "policy_none" : "not_allowlisted", ip };
}

// --- HTTPS (and any TLS / arbitrary TCP) via CONNECT tunnelling ---------------
function buildServer() {
  const server = http.createServer((req, res) => {
    // Absolute-form plain-HTTP proxying: GET http://host/path
    void handleHttp(req, res);
  });
  wireConnect(server);
  return server;
}

function wireConnect(server) {
  server.on("connect", async (req, clientSocket, head) => {
    const { host: hostRaw, port } = splitHostPort(req.url, 443);
    const d = await decide(hostRaw, port);
    logDecision({ method: "CONNECT", host: hostRaw, port, ok: d.ok, why: d.ok ? d.why : d.reason, ip: d.ip });
    if (!d.ok) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\nX-Egress-Reason: " + d.reason + "\r\nConnection: close\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(port, d.ip, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: clawhub-egress\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const bail = () => { try { upstream.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
    upstream.on("error", bail);
    clientSocket.on("error", bail);
  });
}

async function handleHttp(req, res) {
  let target;
  try { target = new URL(req.url); } catch { res.writeHead(400).end("bad request"); return; }
  if (target.protocol !== "http:") { res.writeHead(400).end("only http absolute-form"); return; }
  const port = Number(target.port || 80);
  const d = await decide(target.hostname, port);
  logDecision({ method: req.method, host: target.hostname, port, ok: d.ok, why: d.ok ? d.why : d.reason, ip: d.ip });
  if (!d.ok) { res.writeHead(403, { "x-egress-reason": d.reason }).end("egress blocked: " + d.reason); return; }
  const headers = { ...req.headers };
  // Connect to the pinned IP but keep the real Host header so vhosts work.
  const proxyReq = http.request({
    host: d.ip, port, method: req.method,
    path: target.pathname + target.search,
    headers: { ...headers, host: target.host },
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => { try { res.writeHead(502).end("upstream error"); } catch {} });
  req.pipe(proxyReq);
}

// Exported for unit tests (pure decision helpers + a server factory). The proxy
// only binds a port when run directly, so importing it has no side effects.
module.exports = { matchOne, matchAny, isPrivateIp, ipv6Bytes, splitHostPort, decide, buildServer };

if (require.main === module) {
  const server = buildServer();
  server.listen(PORT, "0.0.0.0", () => {
    logDecision({ event: "listening", port: PORT, policy: ENV_CFG.policy, allow: ENV_CFG.allow, infra: ENV_CFG.infra, softInfra: ENV_CFG.softInfra });
  });
}
