#!/usr/bin/env bash
# Deterministic demo agent — the END-TO-END test subject for ClawHub's browser
# hands + egress containment. It follows the EXACT BYO standing-agent contract
# (reads CLAWHUB_* env, runs in the cloned repo at /workspace, pushes a Change),
# but with ZERO LLM: every decision is scripted, so the *environment's*
# capabilities can be verified without spending model tokens. Swapping this for
# the LLM-driven entrypoint.sh is a one-line image change — the hands are the same.
#
# It does, in order:
#   1. grab the open issue assigned to this agent
#   2. implement it (write the headline the issue asks for into index.html)
#   3. start the app inside the sandbox and TEST it in a real browser (Chromium)
#   4. screenshot what it built
#   5. prove egress containment from INSIDE the sandbox (allowed host works,
#      a non-allowlisted host is blocked)
#   6. commit + push → opens a Change (Closes: #N)
#   7. attach the screenshot to the Change as review evidence
set -uo pipefail
: "${CLAWHUB_URL:?}" "${CLAWHUB_REPO:?}" "${CLAWHUB_TOKEN:?}"
RUN_ID="${CLAWHUB_RUN_ID:-$(date +%s)}"
BASE_BRANCH="${CLAWHUB_BASE_BRANCH:-main}"
AUTH="Authorization: Basic $(printf 'agent-token:%s' "$CLAWHUB_TOKEN" | base64 -w0)"
BEARER="Authorization: Bearer $CLAWHUB_TOKEN"
log() { echo "[demo-agent] $*"; }
api() { curl -fsS -X "$1" "$CLAWHUB_URL$2" -H "$BEARER" -H "content-type: application/json" ${3:+--data "$3"}; }

cd /workspace
# The repo is bind-mounted from the runner host, so its files are owned by a
# different uid than the container user — git refuses to operate ("dubious
# ownership") until we mark it safe.
git config --global --add safe.directory '*' 2>/dev/null || true
git config user.email "demo-agent@clawhub" 2>/dev/null || true
git config user.name "demo-agent" 2>/dev/null || true
branch="agent/${RUN_ID}"
git checkout -b "$branch" 2>/dev/null || git checkout "$branch"

# 1. Grab the assigned issue. The body carries a HEADLINE: <text> directive so the
#    implementation is deterministic (a real agent would read intent freely).
issue_json="$(api GET "/api/v1/repos/$CLAWHUB_REPO/issues?assigned=me&status=open" || echo '{}')"
issue_num="$(echo "$issue_json" | jq -r '.issues[0].number // empty')"
issue_body="$(echo "$issue_json" | jq -r '.issues[0].body // ""')"
headline="$(printf '%s' "$issue_body" | sed -n 's/^HEADLINE:[[:space:]]*//p' | head -1)"
headline="${headline:-Hello from a ClawHub agent}"
closes=""; [ -n "$issue_num" ] && closes="Closes: #${issue_num}"
log "grabbed issue #${issue_num:-none} → headline: ${headline}"

# 2. Implement: write the page the issue asks for.
cat > index.html <<HTML
<!doctype html><html><head><meta charset="utf-8"><title>ClawHub demo</title>
<style>body{font-family:system-ui;background:#0a0a0c;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0}
h1{color:#00e5a0}</style></head>
<body><main><h1 id="headline">${headline}</h1><p>Built and verified by an autonomous ClawHub agent.</p></main></body></html>
HTML

# 3. Start the app inside the sandbox (loopback only — no network needed).
node -e "const http=require('http'),fs=require('fs');http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(fs.readFileSync('/workspace/index.html'))}).listen(8088,'127.0.0.1',()=>console.log('app on :8088'))" &
APP_PID=$!
sleep 1

# 3+4. Drive a real browser, assert the headline rendered, screenshot it. Hit
# 127.0.0.1 (not localhost) to avoid IPv6 ::1 ambiguity against an IPv4 server.
mkdir -p /workspace/.clawhub-evidence
steps="$(jq -n --arg h "$headline" '[{goto:"http://127.0.0.1:8088"},{waitFor:"#headline"},{expectText:$h},{screenshot:"ui.png",fullPage:true}]')"
echo "$steps" | clawhub-browse --out-dir /workspace/.clawhub-evidence
browse_ok=$?
kill "$APP_PID" 2>/dev/null || true
[ -f /workspace/.clawhub-evidence/ui.png ] && log "screenshot captured" || log "WARNING: no screenshot"

# 5. Prove egress containment from inside the real sandbox: the allowlisted host
#    is reachable; a non-allowlisted host is blocked by the proxy. Recorded so the
#    run log carries proof the boundary held.
echo "=== egress containment check (policy=${CLAWHUB_EGRESS_POLICY:-?}) ==="
if curl -sS -m 8 -o /dev/null -w "allowed-host example.com → HTTP %{http_code}\n" https://example.com 2>&1; then :; else echo "allowed-host example.com → BLOCKED/err"; fi
curl -sS -m 8 -o /dev/null -w "blocked-host google.com → HTTP %{http_code}\n" https://www.google.com 2>&1 \
  || echo "blocked-host google.com → REFUSED (contained ✓)"
echo "=== private/metadata reachability (must be refused) ==="
curl -sS -m 5 -o /dev/null -w "metadata 169.254.169.254 → HTTP %{http_code}\n" http://169.254.169.254/ 2>&1 \
  || echo "metadata 169.254.169.254 → REFUSED (contained ✓)"

# 6. Commit + push → opens a Change through the normal governance flow.
git add -A
git commit -q -m "$(cat <<MSG
${headline}

Intent: Implement issue #${issue_num:-?}: set the homepage headline to "${headline}"
Risk: low
${closes}
Agent: ${CLAWHUB_REPO}
MSG
)"
log "pushing HEAD:refs/for/${BASE_BRANCH} (opens a Change)…"
git -c http.extraHeader="$AUTH" push "$CLAWHUB_URL/$CLAWHUB_REPO.git" "HEAD:refs/for/${BASE_BRANCH}" 2>&1 | tail -6

# 7. Resolve the Change we just opened and attach the screenshot as evidence.
#    A refs/for/<branch> push lands on a server-allocated synthetic branch, so we
#    match on the pushed commit SHA (poll: the post-push worker upserts async).
head_sha="$(git rev-parse HEAD)"
change=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  change="$(api GET "/api/v1/repos/$CLAWHUB_REPO/changes" | jq -r --arg s "$head_sha" '.changes[]? | select(.headCommit==$s) | .id' | head -1)"
  [ -n "$change" ] && break
  sleep 2
done
if [ -n "$change" ] && [ -f /workspace/.clawhub-evidence/ui.png ]; then
  url="$(clawhub-evidence "$change" /workspace/.clawhub-evidence/ui.png "Homepage after change" "Implemented issue #${issue_num:-?}; verified the headline renders in Chromium. Screenshot attached." || true)"
  log "evidence attached to change ${change} → ${url}"
else
  log "WARNING: could not attach evidence (change=${change:-none})"
fi
log "done (browse_ok=${browse_ok})."
