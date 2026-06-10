// Helpers for GitHub-style /tree/<ref>/<path> and /blob/<ref>/<path> URLs.
// Branch names may contain slashes, so the ref/path split is resolved against
// the repo's actual branch list: the longest branch name that prefix-matches
// the slug wins; otherwise the first segment is treated as the ref (a SHA or
// unknown branch).

export function splitRefPath(slug: string[], branchNames: string[]): { ref: string; path: string } {
  const joined = slug.join("/");
  let best = "";
  for (const b of branchNames) {
    if ((joined === b || joined.startsWith(b + "/")) && b.length > best.length) best = b;
  }
  if (best) return { ref: best, path: joined.slice(best.length).replace(/^\//, "") };
  return { ref: slug[0] ?? "", path: slug.slice(1).join("/") };
}

export function treeUrl(ns: string, repo: string, ref: string, path = ""): string {
  const tail = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  return `/repos/${ns}/${repo}/tree/${ref.split("/").map(encodeURIComponent).join("/")}${tail}`;
}

export function blobUrl(ns: string, repo: string, ref: string, path: string): string {
  return `/repos/${ns}/${repo}/blob/${ref.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Parse a "#L10" / "#L10-L20" fragment into a line range. */
export function parseLineHash(hash: string): { start: number; end: number } | null {
  const m = hash.match(/^#?L(\d+)(?:-L?(\d+))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
