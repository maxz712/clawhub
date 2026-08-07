// Pre-receive-style scan. Returns an array of hits in the new commits;
// the caller decides whether to reject the push.

export interface SecretHit { kind: string; path: string; line: number; excerpt: string }

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  // Case-INSENSITIVE (#130): the canonical way an AWS secret reaches git is the
  // uppercase env-var form (`AWS_SECRET_ACCESS_KEY=…` in a .env or CI config),
  // which the case-sensitive pattern missed entirely — only the lowercase
  // `aws_secret_access_key=` spelling matched. Quotes join the separator class
  // for the same reason: `AWS_SECRET_ACCESS_KEY="…"` (JSON/YAML/shell) is at
  // least as common as the bare form and used to fall outside the 20-char
  // window. The trailing boundary pins the token to EXACTLY 40 base64 chars (an
  // AWS secret key's real length) so a longer base64 blob on an `aws`-mentioning
  // line (an npm `integrity` sha512, a build hash) no longer matches a 40-char
  // window inside it — without that, case-insensitivity would be a false-positive
  // machine.
  { kind: "aws-secret-key", re: /aws(.{0,20})?[\s:="'`]+[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i },
  { kind: "gh-pat", re: /ghp_[A-Za-z0-9]{36}/ },
  { kind: "gh-token", re: /github_pat_[A-Za-z0-9_]{82}/ },
  { kind: "slack-token", re: /xox[abpr]-[0-9]{10,15}-[0-9]{10,15}-[A-Za-z0-9]{24,}/ },
  { kind: "stripe-secret", re: /sk_live_[A-Za-z0-9]{24,}/ },
  { kind: "private-key", re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: "google-api-key", re: /AIza[0-9A-Za-z\-_]{35}/ },
  { kind: "openai-key", re: /sk-[A-Za-z0-9]{20,}(?:T3BlbkFJ[A-Za-z0-9]{20,})?/ },
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9\-_]{80,}/ },
  // ClawHub agent tokens are JWTs (`eyJ...`), not a `clw_agent_` format — the
  // real leak vector is committing the documented push remote with the credential
  // embedded, e.g. https://agent-token:eyJ...@host/ns/repo.git. Match that
  // precise shape (the literal `agent-token` user + a JWT) so we catch a leaked
  // agent token without false-positiving on every JWT in the diff.
  { kind: "clawhub-agent-token", re: /agent-token:eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+@/ },
];

// Ignore files likely to include intentional samples or binary noise.
// Test directories are exempt: scanner/SAST test suites legitimately embed
// example credentials (e.g. AWS's documented `AKIA…EXAMPLE` key id — elided,
// because since #130 the gate reads every git-changed path, so spelling it out
// here would make this file reject any push that edits it) as
// fixtures — without the exemption a repo cannot host tests for its own
// secret scanning. The trade-off (a real secret pasted into a test file
// goes unflagged) matches mainstream scanner defaults.
const IGNORE_EXT = /\.(png|jpe?g|gif|webp|pdf|zip|tar|gz|7z|woff2?|eot|ttf|otf|ico|mp4|mov|avi|wav|mp3|flac)$/i;
const IGNORE_PATH = /(?:^|\/)(?:vendor|node_modules|dist|build|\.next|\.git|testdata|fixtures|__snapshots__|tests?|__tests__|spec)\//;

/**
 * A path the scanner is willing to look at. Exported so callers can avoid
 * READING blobs the scan would drop on the floor anyway (post-push bulk-reads
 * every changed path — filtering here keeps that read no bigger than it must be).
 */
export function isScannablePath(path: string): boolean {
  return !IGNORE_EXT.test(path) && !IGNORE_PATH.test(path);
}

// Total decoded bytes the push scan will chew through before it gives up. A
// bound is needed because this runs on the SERIAL post-push worker, but it is
// deliberately far above any human-authored push (a 64 MiB text diff), and
// tripping it is REPORTED (log + `clawhub_secret_scan_truncated_total`) rather
// than silently skipping files the way the old `slice(0, 40)` cap did.
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface PushScanResult {
  /** Hits found; empty when clean. Stops at the FIRST file that hits. */
  hits: SecretHit[];
  /** Files actually read + line-scanned. */
  scanned: number;
  /** Paths skipped because the extension/directory is on the ignore list. */
  skippedIgnored: number;
  /** Paths skipped because the blob looked binary (a NUL byte in the head). */
  skippedBinary: number;
  /** True when the byte budget ran out — some paths were NOT scanned. */
  truncated: boolean;
  /** Paths left unscanned by truncation (0 unless `truncated`). */
  unscanned: number;
}

/**
 * The hard push gate (#130). `paths` MUST be git-derived (`numstat`), never the
 * author-declared `Scope:` trailer — the pusher writes that trailer, so driving
 * the one gate that stops a credential from entering history off it let anyone
 * hide a leaked key by simply omitting the file from `Scope:`.
 *
 * Every path is scanned: there is no file-count cap, because "the 41st changed
 * file is never looked at" is the same silent-skip bug class as #118.
 */
export function scanPushedFiles(
  paths: string[],
  contents: Map<string, string>,
  opts: { maxTotalBytes?: number } = {},
): PushScanResult {
  const maxTotalBytes = opts.maxTotalBytes ?? Number(process.env.CLAWHUB_SECRET_SCAN_MAX_BYTES ?? DEFAULT_MAX_TOTAL_BYTES);
  const res: PushScanResult = { hits: [], scanned: 0, skippedIgnored: 0, skippedBinary: 0, truncated: false, unscanned: 0 };
  let budget = maxTotalBytes;
  const seen = new Set<string>();
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (seen.has(p)) continue;
    seen.add(p);
    const content = contents.get(p);
    // Deleted paths (and the old side of a rename) have no blob at the new
    // commit — nothing to scan, and not a skip worth counting.
    if (content === undefined) continue;
    if (!isScannablePath(p)) { res.skippedIgnored++; continue; }
    // Binary blobs decode to mojibake whose "lines" are unbounded; the line
    // regexes cannot meaningfully match them. Counted, not silent.
    if (content.slice(0, 8192).includes("\0")) { res.skippedBinary++; continue; }
    if (content.length > budget) { res.truncated = true; res.unscanned = paths.length - i; break; }
    budget -= content.length;
    res.scanned++;
    const hits = scanFile(p, content);
    if (hits.length) { res.hits = hits; return res; }
  }
  return res;
}

export function scanDiff(diff: string): SecretHit[] {
  const out: SecretHit[] = [];
  const files = diff.split(/(?=^diff --git )/m);
  for (const f of files) {
    const pathMatch = f.match(/^\+\+\+ b\/(.+)$/m);
    if (!pathMatch) continue;
    const path = pathMatch[1];
    if (IGNORE_EXT.test(path) || IGNORE_PATH.test(path)) continue;

    let lineNo = 0;
    for (const line of f.split("\n")) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { lineNo = Number(hunk[1]) - 1; continue; }
      if (!line.startsWith("+") || line.startsWith("+++")) {
        if (!line.startsWith("-")) lineNo++;
        continue;
      }
      lineNo++;
      const body = line.slice(1);
      for (const p of PATTERNS) {
        if (p.re.test(body)) {
          out.push({ kind: p.kind, path, line: lineNo, excerpt: body.slice(0, 240) });
          break;
        }
      }
    }
  }
  return out;
}

// Scan a file blob directly (e.g. when we read the file from the pushed tree).
export function scanFile(path: string, content: string): SecretHit[] {
  if (IGNORE_EXT.test(path) || IGNORE_PATH.test(path)) return [];
  const out: SecretHit[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      if (p.re.test(lines[i])) {
        out.push({ kind: p.kind, path, line: i + 1, excerpt: lines[i].slice(0, 240) });
        break;
      }
    }
  }
  return out;
}
