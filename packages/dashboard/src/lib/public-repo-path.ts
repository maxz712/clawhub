// URL builders for the logged-out PUBLIC repo browse surface, which lives at
// /r/<ns>/<repo>/... (OUTSIDE the login-gated (app) route group). These mirror
// lib/repo-path.ts's treeUrl/blobUrl but target the public prefix, so public
// pages never link a visitor into /repos/... (which would bounce to /login).
// Ref/path splitting + line-hash parsing are identical concerns — reuse them
// from lib/repo-path so the public and app surfaces agree on the boundary.
export { splitRefPath, parseLineHash } from "./repo-path";

export function pubRepoUrl(ns: string, repo: string): string {
  return `/r/${encodeURIComponent(ns)}/${encodeURIComponent(repo)}`;
}

export function pubTreeUrl(ns: string, repo: string, ref: string, path = ""): string {
  const tail = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  return `${pubRepoUrl(ns, repo)}/tree/${ref.split("/").map(encodeURIComponent).join("/")}${tail}`;
}

export function pubBlobUrl(ns: string, repo: string, ref: string, path: string): string {
  return `${pubRepoUrl(ns, repo)}/blob/${ref.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
