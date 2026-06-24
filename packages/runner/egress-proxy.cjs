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
 *                  from a private address). These are operator-trusted.
 *
 * Hard invariant, enforced in EVERY mode (including `all`): a connection whose
 * resolved address is private / loopback / link-local / unique-local / CGNAT /
 * cloud-metadata is REFUSED unless the host is an explicit infra host. This is
 * the SSRF / lateral-movement guard — "open to the internet" never means "open
 * to the Postgres on the same box" or "open to 169.254.169.254".
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

/** Parse an IPv4/IPv6 string and decide if it is a private / non-internet address. */
function isPrivateIp(ip) {
  if (!ip) return true;
  let s = ip;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) → treat as the embedded v4.
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) s = mapped[1];
  if (net.isIPv4(s)) {
    const p = s.split(".").map(Number);
    if (p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
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
  if (net.isIPv6(s)) {
    const x = s.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (x.startsWith("fe80")) return true;    // link-local
    if (x.startsWith("fc") || x.startsWith("fd")) return true; // unique-local fc00::/7
    if (x.startsWith("fec0")) return true;    // deprecated site-local
    if (x.startsWith("ff")) return true;      // multicast
    return false;
  }
  return true; // unparseable → fail closed
}

/**
 * Resolve `host` and decide whether the connection is permitted. Returns the
 * pinned IP to connect to, or a refusal reason. Never throws.
 */
async function decide(host, port, cfg = ENV_CFG) {
  const policy = (cfg.policy || "none").toLowerCase();
  const allow = cfg.allow || [];
  const infraList = cfg.infra || [];
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return { ok: false, reason: "no_host" };
  const infra = matchAny(h, infraList);

  // Resolve to a concrete address and PIN it (anti DNS-rebind).
  let ip;
  // If the host is already a literal IP, use it directly.
  if (net.isIP(h)) ip = h;
  else {
    try { ip = (await dns.lookup(h)).address; }
    catch (e) { return { ok: false, reason: "dns_fail", detail: String(e && e.code || e) }; }
  }

  // Infra hosts are operator-trusted and may legitimately be private (single-box
  // self-host). Everything else is subject to the private-range guard in ALL modes.
  if (!infra && isPrivateIp(ip)) return { ok: false, reason: "private_ip", ip };

  if (infra) return { ok: true, ip, why: "infra" };
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
    const [hostRaw, portRaw] = String(req.url || "").split(":");
    const port = Number(portRaw || 443);
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
module.exports = { matchOne, matchAny, isPrivateIp, decide, buildServer };

if (require.main === module) {
  const server = buildServer();
  server.listen(PORT, "0.0.0.0", () => {
    logDecision({ event: "listening", port: PORT, policy: ENV_CFG.policy, allow: ENV_CFG.allow, infra: ENV_CFG.infra });
  });
}
