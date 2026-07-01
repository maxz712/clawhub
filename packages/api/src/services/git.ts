import simpleGit, { type SimpleGit } from "simple-git";
import { spawn } from "node:child_process";
import { mkdir, access, rm } from "node:fs/promises";
import path from "node:path";
import { GitError } from "./errors.js";

export class GitService {
  constructor(public readonly basePath: string) {}

  pathOf(namespace: string, repo: string): string {
    return path.resolve(this.basePath, namespace, `${repo}.git`);
  }

  async exists(namespace: string, repo: string): Promise<boolean> {
    try { await access(this.pathOf(namespace, repo)); return true; } catch { return false; }
  }

  async initBare(namespace: string, repo: string): Promise<string> {
    const dir = this.pathOf(namespace, repo);
    await mkdir(dir, { recursive: true });
    await simpleGit(dir).init(true);
    return dir;
  }

  async remove(namespace: string, repo: string): Promise<void> {
    await rm(this.pathOf(namespace, repo), { recursive: true, force: true });
  }

  open(namespace: string, repo: string): SimpleGit {
    return simpleGit(this.pathOf(namespace, repo));
  }

  async headCommit(namespace: string, repo: string, ref: string): Promise<string> {
    // `git rev-parse` echoes `--end-of-options`, so guard option-injection by
    // rejecting an option-like ref outright (a real ref never starts with `-`).
    if (ref.startsWith("-")) throw new GitError(`failed to resolve ${ref}: invalid ref`);
    try {
      return (await this.open(namespace, repo).revparse([ref])).trim();
    } catch (e) {
      throw new GitError(`failed to resolve ${ref}: ${(e as Error).message}`);
    }
  }

  async commitMessage(namespace: string, repo: string, sha: string): Promise<string> {
    return (await this.open(namespace, repo).show([sha, "--pretty=%B", "--no-patch"])).trim();
  }

  async listCommits(namespace: string, repo: string, range: string, limit = 50): Promise<Array<{ sha: string; subject: string; message: string }>> {
    const out = await this.open(namespace, repo).raw(["log", range, `--max-count=${limit}`, "--pretty=format:%H%x1f%s%x1f%B%x1e"]);
    if (!out.trim()) return [];
    return out.trim().split("\x1e").filter(Boolean).map(rec => {
      const [sha, subject, message] = rec.split("\x1f");
      return { sha, subject: subject ?? "", message: message ?? "" };
    });
  }

  async diffNameOnly(namespace: string, repo: string, from: string, to: string): Promise<string[]> {
    const out = await this.open(namespace, repo).raw(["diff", "--name-only", `${from}..${to}`]);
    return out.split("\n").map(s => s.trim()).filter(Boolean);
  }

  /**
   * One `git diff --numstat` process yields per-file added/deleted counts plus
   * the changed-path list — everything the risk engine needs in a single call.
   * Binary files report "-\t-" in numstat; we treat those as 0 lines but still
   * count the path as changed.
   */
  async numstat(namespace: string, repo: string, from: string, to: string): Promise<{ paths: string[]; additions: number; deletions: number; files: Array<{ path: string; additions: number; deletions: number }> }> {
    const paths: string[] = [];
    const files: Array<{ path: string; additions: number; deletions: number }> = [];
    let additions = 0, deletions = 0;
    try {
      const out = await this.open(namespace, repo).raw(["diff", "--numstat", `${from}..${to}`]);
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        const [add, del, ...rest] = line.split("\t");
        const path = rest.join("\t");
        if (!path) continue;
        paths.push(path);
        // Binary files report "-" for both columns; count them as 0 lines so they
        // never inflate the size metric.
        const a = add !== "-" ? (Number(add) || 0) : 0;
        const d = del !== "-" ? (Number(del) || 0) : 0;
        files.push({ path, additions: a, deletions: d });
        additions += a;
        deletions += d;
      }
    } catch { /* empty diff or bad range → zeros */ }
    return { paths, additions, deletions, files };
  }

  async diffRaw(namespace: string, repo: string, from: string, to: string, paths?: string[]): Promise<string> {
    const args = ["diff", `${from}..${to}`];
    if (paths?.length) args.push("--", ...paths);
    return await this.open(namespace, repo).raw(args);
  }

  /**
   * Bulk file read: one `git cat-file --batch` process for all paths instead
   * of a spawn per file. Missing paths are simply absent from the result.
   */
  async filesAt(namespace: string, repo: string, commit: string, paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!paths.length) return out;
    return new Promise(resolve => {
      const child = spawn("git", ["-C", this.pathOf(namespace, repo), "cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", c => chunks.push(c));
      child.on("error", () => resolve(out));
      child.on("close", () => {
        const buf = Buffer.concat(chunks);
        let off = 0;
        for (const p of paths) {
          const nl = buf.indexOf(0x0a, off);
          if (nl === -1) break;
          const header = buf.subarray(off, nl).toString();
          off = nl + 1;
          if (header.endsWith(" missing")) continue;
          const size = Number(header.split(" ")[2]);
          if (!Number.isFinite(size)) break;
          out.set(p, buf.subarray(off, off + size).toString("utf8"));
          off += size + 1; // content + trailing newline
        }
        resolve(out);
      });
      child.stdin.write(paths.map(p => `${commit}:${p}`).join("\n") + "\n");
      child.stdin.end();
    });
  }

  async fileAt(namespace: string, repo: string, commit: string, file: string): Promise<string | null> {
    try {
      // `--end-of-options` so a caller-controlled `commit` like `--output=/path`
      // can never be parsed as a git-show flag (it has --output=, which would
      // write to an arbitrary host path). Everything after it is a revision.
      return await this.open(namespace, repo).show(["--end-of-options", `${commit}:${file}`]);
    } catch { return null; }
  }

  /**
   * Byte size of the object at `<commit>:<file>` (`git cat-file -s`), without
   * reading its contents — so a caller can refuse to load a huge blob into
   * memory. Returns null only when the object is MISSING. Note: `cat-file -s`
   * also succeeds for a tree/directory (returning the tree object's size), so
   * this is NOT an is-blob check — the /raw caller relies on the subsequent
   * fileBytesAt (`cat-file blob`) to 404 a non-blob path.
   */
  async blobSizeAt(namespace: string, repo: string, commit: string, file: string): Promise<number | null> {
    try {
      const out = await this.open(namespace, repo).raw(["cat-file", "-s", "--end-of-options", `${commit}:${file}`]);
      const n = Number(out.trim());
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  }

  /**
   * Raw bytes of a blob at a commit (for serving/downloading binary files —
   * fileAt mangles binary via simple-git's utf8 decode). Spawns `git cat-file
   * blob` and collects stdout as a Buffer. Returns null when the path is missing.
   */
  async fileBytesAt(namespace: string, repo: string, commit: string, file: string): Promise<Buffer | null> {
    return new Promise(resolve => {
      const child = spawn("git", ["-C", this.pathOf(namespace, repo), "cat-file", "blob", "--end-of-options", `${commit}:${file}`], { stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", c => chunks.push(c));
      child.on("error", () => resolve(null));
      child.on("close", code => resolve(code === 0 ? Buffer.concat(chunks) : null));
    });
  }

  async trialMerge(namespace: string, repo: string, base: string, head: string): Promise<{ conflicts: boolean }> {
    const g = this.open(namespace, repo);
    try {
      const out = await g.raw(["merge-tree", "--write-tree", base, head]);
      return { conflicts: /^changed in both/m.test(out) || /CONFLICT/m.test(out) };
    } catch (e) {
      // Fall back: older git — just return no-conflict signal to avoid false blocks.
      return { conflicts: false };
    }
  }

  async mergeInto(namespace: string, repo: string, baseBranch: string, headCommit: string, authorName: string, authorEmail: string, message: string): Promise<string> {
    const dir = this.pathOf(namespace, repo);
    const g = simpleGit(dir).env({ GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail });
    const baseSha = (await g.revparse([baseBranch])).trim();
    const tree = (await g.raw(["merge-tree", "--write-tree", baseSha, headCommit])).trim().split(/\s+/)[0];
    if (!tree) throw new GitError("merge-tree produced no tree");
    const commit = (await g.raw(["commit-tree", tree, "-p", baseSha, "-p", headCommit, "-m", message])).trim();
    await g.raw(["update-ref", `refs/heads/${baseBranch}`, commit, baseSha]);
    return commit;
  }

  async squashInto(namespace: string, repo: string, baseBranch: string, headCommit: string, authorName: string, authorEmail: string, message: string): Promise<string> {
    const dir = this.pathOf(namespace, repo);
    const g = simpleGit(dir).env({ GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail });
    const baseSha = (await g.revparse([baseBranch])).trim();
    const tree = (await g.raw(["merge-tree", "--write-tree", baseSha, headCommit])).trim().split(/\s+/)[0];
    if (!tree) throw new GitError("merge-tree produced no tree");
    const commit = (await g.raw(["commit-tree", tree, "-p", baseSha, "-m", message])).trim();
    await g.raw(["update-ref", `refs/heads/${baseBranch}`, commit, baseSha]);
    return commit;
  }

  async rebaseInto(namespace: string, repo: string, baseBranch: string, headCommit: string, authorName: string, authorEmail: string): Promise<string> {
    const dir = this.pathOf(namespace, repo);
    const g = simpleGit(dir).env({ GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail });
    const baseSha = (await g.revparse([baseBranch])).trim();
    const mergeBase = (await g.raw(["merge-base", baseSha, headCommit])).trim();
    const shas = (await g.raw(["rev-list", "--reverse", `${mergeBase}..${headCommit}`])).trim().split("\n").filter(Boolean);

    let parent = baseSha;
    for (const sha of shas) {
      const treeOut = (await g.raw(["merge-tree", "--write-tree", parent, sha])).trim().split(/\s+/)[0];
      if (!treeOut) throw new GitError(`rebase failed at ${sha}`);
      const origMsg = await this.commitMessage(namespace, repo, sha);
      const commit = (await g.raw(["commit-tree", treeOut, "-p", parent, "-m", origMsg])).trim();
      parent = commit;
    }
    await g.raw(["update-ref", `refs/heads/${baseBranch}`, parent, baseSha]);
    return parent;
  }

  async mergeBase(namespace: string, repo: string, a: string, b: string): Promise<string | null> {
    try { return (await this.open(namespace, repo).raw(["merge-base", a, b])).trim() || null; }
    catch { return null; }
  }

  /**
   * True if `ancestor` is an ancestor of `descendant` (or equal). Uses a merge-base
   * COMPARISON, not `--is-ancestor`: simple-git's raw doesn't reliably reject on the
   * latter's exit-1 (no stdout), so it read as "always an ancestor" — which would
   * make every change look up-to-date and break update-branch.
   */
  async isAncestor(namespace: string, repo: string, ancestor: string, descendant: string): Promise<boolean> {
    if (ancestor === descendant) return true;
    return (await this.mergeBase(namespace, repo, ancestor, descendant)) === ancestor;
  }

  /** Point an arbitrary ref at a sha (bare repo). Used to move a Change ref on update-branch. */
  async updateRef(namespace: string, repo: string, ref: string, sha: string): Promise<void> {
    await this.open(namespace, repo).raw(["update-ref", ref, sha]);
  }

  /**
   * "Update branch" — bring `headCommit` current with `baseSha` WITHOUT moving any
   * branch ref (the REVERSE of mergeInto/rebaseInto, which advance the base). Returns
   * the new head sha; the caller points the Change ref at it. Throws GitError on a
   * content conflict (the caller should `trialMerge` first). Base is UNTOUCHED.
   *   method "merge"  — a merge commit with parents [head, base].
   *   method "rebase" — replay head's own commits (mergeBase(base,head)..head) onto base.
   */
  async updateBranchInto(
    namespace: string, repo: string, headCommit: string, baseSha: string,
    method: "merge" | "rebase", authorName: string, authorEmail: string, message: string,
  ): Promise<string> {
    const g = simpleGit(this.pathOf(namespace, repo)).env({ GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail });
    if (method === "merge") {
      const tree = (await g.raw(["merge-tree", "--write-tree", headCommit, baseSha])).trim().split(/\s+/)[0];
      if (!tree) throw new GitError("update-branch: merge produced no tree");
      return (await g.raw(["commit-tree", tree, "-p", headCommit, "-p", baseSha, "-m", message])).trim();
    }
    // rebase: replay the change's own commits onto the base head.
    const mb = (await g.raw(["merge-base", baseSha, headCommit])).trim();
    const shas = (await g.raw(["rev-list", "--reverse", `${mb}..${headCommit}`])).trim().split("\n").filter(Boolean);
    let parent = baseSha;
    for (const sha of shas) {
      const tree = (await g.raw(["merge-tree", "--write-tree", parent, sha])).trim().split(/\s+/)[0];
      if (!tree) throw new GitError(`update-branch: rebase conflict at ${sha}`);
      const origMsg = await this.commitMessage(namespace, repo, sha);
      parent = (await g.raw(["commit-tree", tree, "-p", parent, "-m", origMsg])).trim();
    }
    return parent;
  }

  /**
   * Branch heads (`refs/heads/*`) of a bare repo as `{ name, headCommit }`.
   * Used after an import clone to seed the `branches` table — the dashboard's
   * code browser lists branches from that table, so an imported repo with no
   * branch rows renders "No code yet" even though its code is on disk.
   */
  async listBranches(namespace: string, repo: string): Promise<Array<{ name: string; headCommit: string }>> {
    try {
      const out = await this.open(namespace, repo).raw(["for-each-ref", "--format=%(refname:short)\t%(objectname)", "refs/heads/"]);
      return out.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
        const [name, sha] = l.split("\t");
        return { name: name ?? "", headCommit: sha ?? "" };
      }).filter(b => b.name && b.headCommit);
    } catch { return []; }
  }

  /** List one level of a tree at `ref`. `path` "" means the repo root. */
  async listTree(namespace: string, repo: string, ref: string, path = ""): Promise<Array<{ name: string; path: string; type: "dir" | "file"; size: number | null }>> {
    const spec = path ? `${ref}:${path}` : ref;
    const out = await this.open(namespace, repo).raw(["ls-tree", "-l", "--end-of-options", spec]);
    const entries = out.split("\n").filter(Boolean).map(line => {
      // <mode> <type> <oid> <size>\t<name>
      const [meta, name] = splitOnce(line, "\t");
      const [, type, , size] = meta.split(/\s+/);
      return {
        name,
        path: path ? `${path}/${name}` : name,
        type: (type === "tree" ? "dir" : "file") as "dir" | "file",
        size: size === "-" ? null : Number(size),
      };
    });
    // Directories first, then files, both alphabetical — what file browsers expect.
    return entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
  }

  /**
   * Most-recent commit that touched each immediate child of `path` at `ref`, in
   * ONE bounded `git log --name-status` process (NOT a spawn per entry — that's
   * O(N) processes). We walk commits newest-first; the first commit that touches
   * a given child is its last-commit, and we stop early once every name in
   * `names` is resolved or the commit cap is hit. `path` "" is the repo root.
   *
   * Returns a map name → { sha, message, authoredAt }. Names with no matching
   * commit in the scanned window (e.g. deeper than the cap) are simply absent;
   * the caller renders them without last-commit info.
   */
  async lastCommitsForTree(
    namespace: string,
    repo: string,
    ref: string,
    path: string,
    names: string[],
    commitCap = 500,
  ): Promise<Map<string, { sha: string; message: string; authoredAt: string }>> {
    const out = new Map<string, { sha: string; message: string; authoredAt: string }>();
    if (!names.length) return out;
    const want = new Set(names);
    const prefix = path ? `${path}/` : "";
    // Record separator \x1e between commits, unit separator \x1f between fields.
    // %x00 is impossible in a commit subject, so %s is safe single-line here.
    const fmt = "%x1e%H%x1f%aI%x1f%s";
    let log: string;
    try {
      const args = ["log", `--max-count=${commitCap}`, `--format=${fmt}`, "--name-status", "-z", "--end-of-options", ref];
      if (path) args.push("--", path);
      log = await this.open(namespace, repo).raw(args);
    } catch {
      return out; // bad ref / empty history → no last-commit info
    }
    // With -z, paths are NUL-terminated and the format text rides inline. Split
    // on the record separator we injected; each chunk is one commit's header plus
    // its NUL-separated name-status fields.
    for (const rec of log.split("\x1e")) {
      if (!rec) continue;
      if (want.size === 0) break;
      // The first \x00 closes the header line; everything after is name-status.
      const nul = rec.indexOf("\x00");
      const header = (nul === -1 ? rec : rec.slice(0, nul)).trim();
      const [sha, authoredAt, subject] = header.split("\x1f");
      if (!sha) continue;
      const commit = { sha, message: (subject ?? "").trim(), authoredAt: authoredAt ?? "" };
      // name-status under -z: status token, then 1 path (A/M/D…) or 2 paths
      // (R…/C…), each its own NUL-separated field. We only care about the
      // resulting path's immediate child under `path`.
      const fields = (nul === -1 ? "" : rec.slice(nul + 1)).split("\x00").filter(Boolean);
      let i = 0;
      while (i < fields.length) {
        // git -z puts a structural newline between the commit header and the
        // name-status block, so the FIRST status token arrives as "\nR100" —
        // trim it or rename/copy detection (startsWith R/C) silently misses.
        const status = fields[i++].replace(/^\s+/, "");
        if (!status) continue; // a stray trailing "\n" field
        const isRename = status.startsWith("R") || status.startsWith("C");
        if (isRename) i++; // skip the source path; the destination path follows
        const changed = fields[i++];
        if (!changed) break;
        if (!changed.startsWith(prefix)) continue;
        const child = changed.slice(prefix.length).split("/")[0];
        if (!child || !want.has(child)) continue;
        out.set(child, commit);
        want.delete(child);
        if (want.size === 0) break;
      }
    }
    return out;
  }

  /** Opportunistic maintenance — no-op until git's loose-object threshold is hit. */
  async gcAuto(namespace: string, repo: string): Promise<void> {
    try { await this.open(namespace, repo).raw(["gc", "--auto", "--quiet"]); } catch { /* never block callers */ }
  }

  async countLocBetween(namespace: string, repo: string, from: string, to: string): Promise<number> {
    try {
      const out = await this.open(namespace, repo).raw(["diff", "--shortstat", `${from}..${to}`]);
      const m = out.match(/(\d+) insertion.*?(\d+) deletion/);
      if (!m) {
        const ins = out.match(/(\d+) insertion/);
        const del = out.match(/(\d+) deletion/);
        return (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
      }
      return Number(m[1]) + Number(m[2]);
    } catch { return 0; }
  }

  async blame(namespace: string, repo: string, commit: string, file: string): Promise<Array<{ sha: string; author: string; line: number; content: string }>> {
    try {
      const out = await this.open(namespace, repo).raw(["blame", "--line-porcelain", commit, "--", file]);
      const lines: Array<{ sha: string; author: string; line: number; content: string }> = [];
      const blocks = out.split(/\n(?=[0-9a-f]{40} )/);
      for (const b of blocks) {
        const headerMatch = b.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?/);
        if (!headerMatch) continue;
        const authorMatch = b.match(/^author (.+)$/m);
        const contentMatch = b.match(/\n\t(.*)$/);
        lines.push({
          sha: headerMatch[1],
          line: Number(headerMatch[3]),
          author: authorMatch?.[1] ?? "unknown",
          content: contentMatch?.[1] ?? "",
        });
      }
      return lines;
    } catch { return []; }
  }
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}
