// SSRF guard for server-side fetches against caller-supplied URLs (e.g. an OIDC
// issuer's discovery document, an org-connected LLM baseUrl, a repo webhook).
// The invariant: the address that is VETTED is the address that is CONNECTED to.
//
// This is the strictly-more-privileged sibling of packages/runner/egress-proxy.cjs
// (#131): the API process holds CLAWHUB_SECRETS_KEY and the platform LLM keys and
// sits on the Docker network beside Postgres and Redis, which prod compose gives
// no host ports — network isolation IS their access control, and this process is
// inside it. So the address-classification logic below is ported VERBATIM from the
// egress proxy (canonical IPv6 expansion + a 2000::/3 allowlist), and safeFetch
// pins the resolved IP so a host cannot pass the check and then DNS-rebind to a
// private target. Keep the two in sync — the shared vector table lives at
// packages/api/tests/fixtures/ip-guard-vectors.json.
import { lookup } from "node:dns/promises";
import { isIP, isIPv4, isIPv6 } from "node:net";
import { Agent } from "undici";

/** Is a dotted-quad IPv4 string outside the public internet? */
function isPrivateV4(s: string): boolean {
  const o = s.split(".").map(n => Number(n));
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0) return true;                              // 0.0.0.0/8 "this host"
  if (a === 127) return true;                            // loopback
  if (a === 10) return true;                             // private 10/8
  if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT 100.64/10
  if (a === 169 && b === 254) return true;               // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;      // private 172.16/12
  if (a === 192 && b === 0) return true;                 // 192.0.0/24 (IETF) + docs
  if (a === 192 && b === 168) return true;               // private 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true;  // benchmark 198.18/15
  if (a >= 224) return true;                             // multicast / reserved / 255.x
  return false;
}

/**
 * Expand ANY spelling of an IPv6 address to its canonical 16 bytes — `::`
 * compression, a trailing dotted quad, an expanded 8-group form. Returns null if
 * it does not parse (callers must then fail closed).
 *
 * Deciding on the STRING is what broke containment (#131): `::ffff:127.0.0.1` and
 * `::ffff:7f00:1` are the same address and WHATWG `URL` re-serializes the first
 * into the second, so a spelling-based guard is bypassed by writing the address
 * the other way. Normalize, then decide. Ported from egress-proxy.cjs.
 */
export function ipv6Bytes(str: string): Uint8Array | null {
  let s = String(str).toLowerCase();
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
  let groups: string[];
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

const zeroRun = (b: Uint8Array, from: number, to: number): boolean => { for (let i = from; i < to; i++) if (b[i] !== 0) return false; return true; };
const v4At = (b: Uint8Array, o: number): string => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

/**
 * Parse an IPv4/IPv6 string and decide if it is a private / non-internet address.
 *
 * IPv6 is decided as an ALLOWLIST of what is public, not a denylist of prefixes:
 * global unicast is `2000::/3` and nothing else is a reachable internet address,
 * so every current and FUTURE special-purpose range outside it fails closed by
 * default rather than being silently "public". Any form that EMBEDS an IPv4
 * address (v4-mapped, v4-translated, v4-compatible, 6to4, NAT64 `64:ff9b::/96`)
 * is handed to the v4 table so the embedded address decides. Ported from
 * egress-proxy.cjs `isPrivateIp`.
 */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  let s = String(ip).trim().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (isIPv4(s)) return isPrivateV4(s);
  if (isIPv6(s)) {
    const b = ipv6Bytes(s);
    if (!b) return true; // parsed by node but not by us → fail closed
    if (zeroRun(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(v4At(b, 12));        // ::ffff:0:0/96 v4-mapped
    if (zeroRun(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && zeroRun(b, 10, 12)) return isPrivateV4(v4At(b, 12)); // v4-translated
    if (zeroRun(b, 0, 12)) return isPrivateV4(v4At(b, 12));                                             // ::a.b.c.d (covers ::1, ::)
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(v4At(b, 2));                                 // 6to4 2002::/16
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeroRun(b, 4, 12)) return isPrivateV4(v4At(b, 12)); // NAT64 64:ff9b::/96
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;                  // Teredo 2001::/32
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;                  // 2001:db8::/32 docs
    if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) return true;                          // 3fff::/20 docs
    if ((b[0] & 0xe0) !== 0x20) return true;                                                            // outside 2000::/3
    return false;
  }
  return true; // unparseable → fail closed
}

// A human-readable reason if the literal IP is non-public, else null.
export function ipBlockReason(ip: string): string | null {
  const s = ip.replace(/^\[|\]$/g, "");
  if (isIPv4(s)) return isPrivateV4(s) ? `${ip} is a private/loopback/link-local address` : null;
  if (isIPv6(s)) return isPrivateIp(s) ? `${ip} is a non-public IPv6 address` : null;
  return `"${ip}" is not a valid IP address`;
}

export type ResolveResult = { ok: true; ip: string; family: 4 | 6 } | { ok: false; reason: string };

// Resolve `urlStr`'s host to a concrete, vetted PUBLIC address and PIN it, so the
// caller connects to that exact address (see safeFetch) rather than re-resolving
// the hostname a second time inside fetch() — the resolve-and-discard rebind
// window. `URL.hostname` keeps the brackets on an IPv6 literal, so strip them
// before isIP so a literal actually reaches the classifier (it used to fall
// through to lookup() and be refused as "could not resolve host" — a bracket
// accident, not a containment decision).
export async function resolvePublicHttpTarget(urlStr: string): Promise<ResolveResult> {
  let u: URL;
  try { u = new URL(urlStr); } catch { return { ok: false, reason: "invalid URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "only http(s) URLs may be fetched" };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const fam = isIP(host);
  if (fam) {
    const reason = ipBlockReason(host);
    return reason ? { ok: false, reason } : { ok: true, ip: host, family: fam as 4 | 6 };
  }
  let addrs: Array<{ address: string; family: number }>;
  try { addrs = await lookup(host, { all: true }); } catch { return { ok: false, reason: `could not resolve host "${host}"` }; }
  if (addrs.length === 0) return { ok: false, reason: `could not resolve host "${host}"` };
  for (const a of addrs) {
    if (isPrivateIp(a.address)) return { ok: false, reason: `host "${host}" resolves to a blocked address (${a.address})` };
  }
  const pinned = addrs[0];
  return { ok: true, ip: pinned.address, family: (isIP(pinned.address) || 4) as 4 | 6 };
}

// Validate that `urlStr` is an http(s) URL whose host resolves ONLY to public
// addresses. Returns null when safe, or a reason string when it must be blocked.
// Non-throwing wrapper over resolvePublicHttpTarget, kept for the probe endpoints
// (sso-validate) that fold the reason into an { ok:false } body and for the git
// clone sites that validate a URL they hand to simple-git rather than fetch.
export async function assertPublicHttpHost(urlStr: string): Promise<string | null> {
  const r = await resolvePublicHttpTarget(urlStr);
  return r.ok ? null : r.reason;
}

// Thrown by safeFetch when the (possibly redirected) destination fails the guard.
export class SsrfBlockedError extends Error {
  constructor(public reason: string) { super(`ssrf_blocked: ${reason}`); this.name = "SsrfBlockedError"; }
}

/**
 * fetch() against a caller/tenant-supplied URL with the SSRF invariant enforced:
 * resolve+vet the host, then PIN the connection to the vetted IP (undici's
 * connect.lookup) while keeping the real Host header and TLS SNI, so a DNS
 * rebind between the check and the connect cannot land the socket on an internal
 * target. Redirects are `manual` by default; pass maxRedirects>0 to follow, and
 * every hop is re-vetted (an unvetted Location is refused, never followed). This
 * is the one code path all outbound tenant-host fetches share so a future fix
 * cannot land on only some of them.
 */
export async function safeFetch(urlStr: string, init: RequestInit = {}, opts: { maxRedirects?: number } = {}): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 0;
  let currentUrl = urlStr;
  for (let hop = 0; ; hop++) {
    const target = await resolvePublicHttpTarget(currentUrl);
    if (!target.ok) throw new SsrfBlockedError(target.reason);
    const ip = target.ip;
    const family = target.family;
    // Pin: undici connects to the vetted IP but the request keeps its hostname
    // (Host header + SNI), so vhosts and TLS cert validation still work.
    const dispatcher = new Agent({
      connect: {
        lookup: ((_hostname: string, options: { all?: boolean }, cb: (err: Error | null, addr: unknown, fam?: number) => void) => {
          if (options && options.all) cb(null, [{ address: ip, family }]);
          else cb(null, ip, family);
        }) as never,
      },
    });
    try {
      const res = await fetch(currentUrl, { ...init, redirect: "manual", dispatcher } as RequestInit);
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (loc && hop < maxRedirects) {
        currentUrl = new URL(loc, currentUrl).toString();
        await dispatcher.close().catch(() => {});
        continue;
      }
      // Not a followed redirect: hand the response back. A 3xx here (maxRedirects
      // exhausted or 0) is surfaced to the caller, which treats it as a failure —
      // the internal target the Location points at is never contacted. close() is
      // graceful (it waits for the in-flight response), so the body stays readable.
      void dispatcher.close().catch(() => {});
      return res;
    } catch (e) {
      await dispatcher.close().catch(() => {});
      throw e;
    }
  }
}
