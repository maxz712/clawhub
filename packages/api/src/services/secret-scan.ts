// Pre-receive-style scan. Returns an array of hits in the new commits;
// the caller decides whether to reject the push.

export interface SecretHit { kind: string; path: string; line: number; excerpt: string }

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { kind: "aws-secret-key", re: /aws(.{0,20})?[\s:=]+[A-Za-z0-9/+=]{40}/ },
  { kind: "gh-pat", re: /ghp_[A-Za-z0-9]{36}/ },
  { kind: "gh-token", re: /github_pat_[A-Za-z0-9_]{82}/ },
  { kind: "slack-token", re: /xox[abpr]-[0-9]{10,15}-[0-9]{10,15}-[A-Za-z0-9]{24,}/ },
  { kind: "stripe-secret", re: /sk_live_[A-Za-z0-9]{24,}/ },
  { kind: "private-key", re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: "google-api-key", re: /AIza[0-9A-Za-z\-_]{35}/ },
  { kind: "openai-key", re: /sk-[A-Za-z0-9]{20,}(?:T3BlbkFJ[A-Za-z0-9]{20,})?/ },
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9\-_]{80,}/ },
  { kind: "clawhub-agent-token", re: /clw_agent_[A-Za-z0-9_\-]{30,}/ },
];

// Ignore files likely to include intentional samples or binary noise.
// Test directories are exempt: scanner/SAST test suites legitimately embed
// example credentials (e.g. AWS's documented AKIAIOSFODNN7EXAMPLE) as
// fixtures — without the exemption a repo cannot host tests for its own
// secret scanning. The trade-off (a real secret pasted into a test file
// goes unflagged) matches mainstream scanner defaults.
const IGNORE_EXT = /\.(png|jpe?g|gif|webp|pdf|zip|tar|gz|7z|woff2?|eot|ttf|otf|ico|mp4|mov|avi|wav|mp3|flac)$/i;
const IGNORE_PATH = /(?:^|\/)(?:vendor|node_modules|dist|build|\.next|\.git|testdata|fixtures|__snapshots__|tests?|__tests__|spec)\//;

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
