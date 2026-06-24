// A change pushed to `refs/for/<branch>` is keyed internally as
// `magic/<target>/<head12>` (ref-per-change; see services/ref-rewriter.ts). That
// synthetic ref is an implementation detail, not a branch the human typed — show
// the branch the change TARGETS instead, so the UI reads `→ main` rather than
// `magic/main/9f68d695a4f8`. Non-magic branches pass through unchanged.
const MAGIC_BRANCH = /^magic\/(.+)\/[0-9a-f]{12}$/;

export function displayBranch(branch: string): string {
  const m = branch.match(MAGIC_BRANCH);
  return m ? `→ ${m[1]}` : branch;
}
