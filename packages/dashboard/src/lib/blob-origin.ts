// Decides whether a URL is one of OUR api-hosted blobs — the URLs AuthedImg
// fetches WITH the viewer's JWT attached. This MUST be an origin check, not a
// substring test: the token is the full REST + git-push credential, so a
// `https://evil.tld/api/v1/repos/a/b/evidence/c.png` that merely CONTAINS the
// path markers would otherwise have the browser send `Authorization: Bearer
// <viewer JWT>` off-origin — account takeover via any markdown image URL (#167).
//
// Legitimate blobs are stored as absolute URLs built from the API's own
// publicBaseUrl (routes/change-evidence.ts, routes/issue-attachments.ts), so an
// origin equality check does not break them; relative `/api/v1/repos/...` paths
// resolve against the API origin and stay authed.

const API_ORIGIN: string = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000").origin; }
  catch { return "http://localhost:3000"; }
})();

export function isApiHostedBlob(url: string): boolean {
  let parsed: URL;
  // Resolve relative paths against the API origin; malformed input never throws.
  try { parsed = new URL(url, API_ORIGIN); } catch { return false; }
  if (parsed.origin !== API_ORIGIN) return false;
  // Test the PATHNAME only, so a marker smuggled into the query/hash of an
  // off-path URL on our own origin cannot pass.
  const path = parsed.pathname;
  return path.includes("/api/v1/repos/") && (path.includes("/evidence/") || path.includes("/issue-attachments/"));
}
