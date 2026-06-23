// SSRF guard for server-side fetches against caller-supplied URLs (e.g. an OIDC
// issuer's discovery document). Validates the scheme AND resolves the host,
// rejecting loopback, link-local/cloud-metadata, and private (RFC1918/CGNAT/ULA)
// targets so an org admin cannot turn a "test connection" probe into an internal
// port scanner or a cloud-metadata exfil primitive. Scheme-only checks are NOT
// enough — the host must be proven public.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function v4Blocked(ip: string): boolean {
  const o = ip.split(".").map(n => Number(n));
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0 || a === 127) return true;                 // unspecified / loopback
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

// A human-readable reason if the literal IP is non-public, else null.
function ipBlockReason(ip: string): string | null {
  const fam = isIP(ip);
  if (fam === 4) return v4Blocked(ip) ? `${ip} is a private/loopback/link-local address` : null;
  if (fam === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return v4Blocked(mapped[1]) ? `${ip} maps to a private IPv4 address` : null;
    if (lower === "::1" || lower === "::") return `${ip} is a loopback/unspecified address`;
    if (/^fe[89ab]/.test(lower)) return `${ip} is a link-local address`;  // fe80::/10
    if (/^f[cd]/.test(lower)) return `${ip} is a unique-local address`;    // fc00::/7
    return null;
  }
  return `"${ip}" is not a valid IP address`;
}

// Validate that `urlStr` is an http(s) URL whose host resolves ONLY to public
// addresses. Returns null when safe, or a reason string when it must be blocked.
// Non-throwing so probe endpoints can fold the reason into an { ok:false } body.
export async function assertPublicHttpHost(urlStr: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(urlStr); } catch { return "invalid URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s) URLs may be fetched";
  const host = u.hostname;
  if (isIP(host)) return ipBlockReason(host);
  let addrs: Array<{ address: string }>;
  try { addrs = await lookup(host, { all: true }); } catch { return `could not resolve host "${host}"`; }
  if (addrs.length === 0) return `could not resolve host "${host}"`;
  for (const a of addrs) {
    const reason = ipBlockReason(a.address);
    if (reason) return `host "${host}" resolves to a blocked address (${reason})`;
  }
  return null;
}
