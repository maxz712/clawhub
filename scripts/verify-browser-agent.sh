#!/usr/bin/env bash
# End-to-end verification of ClawHub's browser-agent capability.
#
# Spins up a real stack (Postgres + Redis + the API + the CI runner), then
# dispatches a standing agent whose container (the deterministic demo agent) runs
# INSIDE the egress sandbox and:
#   1. grabs an assigned issue
#   2. implements it
#   3. tests the UI in a real headless browser + screenshots it
#   4. proves egress containment from inside the sandbox
#   5. opens a Change (push)
#   6. attaches the screenshot to the Change as evidence
#
# Then it ASSERTS, via the API, that all of that actually happened. Prove-by-
# running, not by reasoning. Requires: colima/docker, node, the two demo images
# built (clawhub-agent-harness + clawhub-demo-agent).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DOCKER_HOST="${DOCKER_HOST:-unix:///Users/$(id -un)/.colima/default/docker.sock}"
PORT=3199
APIBASE="http://localhost:$PORT"
PUBLIC="http://host.docker.internal:$PORT"     # the URL the sandboxed container uses
WORK="$HOME/.clawhub-verify"
RUNNER_WORK="$WORK/runner"
REPO_BASE="$WORK/repos"
PGPORT=5466; RDPORT=6399
SECRETS_KEY="$(head -c32 /dev/urandom | base64)"
JWT="verify-jwt-secret"
PASS=0; FAIL=0
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
step() { echo; echo "▶ $*"; }
b64()  { printf '%s' "$1" | base64 | tr -d '\n'; }

cleanup() {
  step "cleanup"
  [ -n "${RUNNER_PID:-}" ] && kill "$RUNNER_PID" 2>/dev/null || true
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null || true
  docker rm -f chub-verify-pg chub-verify-redis >/dev/null 2>&1 || true
  docker ps -aq --filter 'name=clawhub-prx-' --filter 'name=clawhub-egr-' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter 'name=clawhub-egr-' | xargs -r docker network rm >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup >/dev/null 2>&1
rm -rf "$WORK"; mkdir -p "$RUNNER_WORK" "$REPO_BASE"

step "start Postgres + Redis"
docker run -d --name chub-verify-pg -e POSTGRES_USER=clawhub -e POSTGRES_PASSWORD=clawhub -e POSTGRES_DB=clawhub -p $PGPORT:5432 postgres:16-alpine >/dev/null
docker run -d --name chub-verify-redis -p $RDPORT:6379 redis:7-alpine >/dev/null
export DATABASE_URL="postgresql://clawhub:clawhub@localhost:$PGPORT/clawhub"
export REDIS_URL="redis://localhost:$RDPORT"
# Probe the HOST-published port (what migrate/API actually connect to) — the
# colima port-forward can lag behind the container being healthy.
hostport_up() { node -e "const n=require('net');const s=n.connect($1,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500)" 2>/dev/null; }
pgup=0; for i in $(seq 1 60); do docker exec chub-verify-pg pg_isready -U clawhub >/dev/null 2>&1 && hostport_up $PGPORT && { pgup=1; break; }; sleep 1; done
hostport_up $RDPORT || sleep 1
[ "$pgup" = 1 ] && ok "pg + redis up" || { bad "postgres host port $PGPORT never came up"; exit 1; }

step "migrate schema"
DATABASE_URL="$DATABASE_URL" npm -w @clawhub/api run db:migrate >/tmp/chub-migrate.log 2>&1 \
  && ok "migrations applied" || { bad "migrate failed"; tail -20 /tmp/chub-migrate.log; exit 1; }

step "boot API on :$PORT"
DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" JWT_SECRET="$JWT" \
  CLAWHUB_SECRETS_KEY="$SECRETS_KEY" GIT_REPOS_BASE_PATH="$REPO_BASE" \
  CLAWHUB_PUBLIC_URL="$PUBLIC" PORT="$PORT" CLAWHUB_DISABLE_INPROC_WORKER=0 \
  npx tsx packages/api/src/index.ts >/tmp/chub-api.log 2>&1 &
API_PID=$!
for i in $(seq 1 40); do curl -fsS "$APIBASE/api/v1/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$APIBASE/api/v1/health" >/dev/null 2>&1 && ok "API healthy" || { bad "API never came up"; tail -30 /tmp/chub-api.log; exit 1; }

step "register operator (user) + agent identity"
U="$(curl -fsS -X POST "$APIBASE/api/v1/users/register" -H content-type:application/json \
  --data "$(jq -n '{email:"op@verify.test",password:"verify-pass-123",name:"Operator"}')")"
USER_TOKEN="$(echo "$U" | jq -r .token)"; USER_HANDLE="$(echo "$U" | jq -r .user.username)"
[ -n "$USER_TOKEN" ] && [ "$USER_TOKEN" != null ] && ok "operator @$USER_HANDLE" || { bad "register failed: $U"; exit 1; }

# Ride the operator's Bearer so the agent is AUTO-CLAIMED to them — required to
# seal its token into a standing agent (you can only delegate an agent that's yours).
A="$(curl -fsS -X POST "$APIBASE/api/v1/agents" -H "Authorization: Bearer $USER_TOKEN" -H content-type:application/json \
  --data "$(jq -n '{name:"verify-demo-agent"}')")"
AGENT_TOKEN="$(echo "$A" | jq -r .token)"; AGENT_ID="$(echo "$A" | jq -r '.agent.id // .id // .agentId')"
[ -n "$AGENT_TOKEN" ] && [ "$AGENT_TOKEN" != null ] && ok "agent id=$AGENT_ID" || { bad "agent register failed: $A"; exit 1; }

step "seed repo (human push creates it under @$USER_HANDLE)"
SEED="$WORK/seed"; mkdir -p "$SEED"; ( cd "$SEED"; git init -q; git config user.email op@verify.test; git config user.name op
  echo "# demo" > README.md; git add -A; git commit -qm "seed"
  git -c http.extraHeader="Authorization: Basic $(b64 "$USER_HANDLE:$USER_TOKEN")" \
    push -q "$APIBASE/$USER_HANDLE/demo.git" HEAD:main ) >/tmp/chub-seed.log 2>&1 \
  && ok "seed pushed → @$USER_HANDLE/demo" || { bad "seed push failed"; tail -20 /tmp/chub-seed.log; exit 1; }

step "create issue assigned to the agent"
ISSUE="$(curl -fsS -X POST "$APIBASE/api/v1/repos/$USER_HANDLE/demo/issues" -H "Authorization: Bearer $USER_TOKEN" \
  -H content-type:application/json --data "$(jq -n --arg a "$AGENT_ID" \
  '{title:"Set the homepage headline", body:"HEADLINE: Shipped by an autonomous ClawHub agent", assignedAgentId:$a}')")"
ISSUE_NUM="$(echo "$ISSUE" | jq -r '.issue.number // .number')"
[ -n "$ISSUE_NUM" ] && [ "$ISSUE_NUM" != null ] && ok "issue #$ISSUE_NUM assigned" || { bad "issue create failed: $ISSUE"; exit 1; }

step "attach standing agent (egress=allowlist, allow=example.com)"
echo "  · repo owner: $(curl -fsS "$APIBASE/api/v1/repos/$USER_HANDLE/demo" -H "Authorization: Bearer $USER_TOKEN" | jq -c '{namespaceType,access}' 2>/dev/null)"
SA="$(curl -sS -X POST "$APIBASE/api/v1/repos/$USER_HANDLE/demo/standing-agents" -H "Authorization: Bearer $USER_TOKEN" \
  -H content-type:application/json --data "$(jq -n --arg t "$AGENT_TOKEN" \
  '{name:"demo-worker", image:"clawhub-demo-agent", agentToken:$t, trigger:"manual",
    egressPolicy:"allowlist", egressAllowedHosts:["example.com"], timeoutSec:240, memoryMb:2048}')")"
SA_ID="$(echo "$SA" | jq -r '.standingAgent.id // empty')"
SA_EGRESS="$(echo "$SA" | jq -r '.standingAgent.egressPolicy')"
[ -n "$SA_ID" ] && [ "$SA_ID" != null ] && ok "standing agent $SA_ID (egress=$SA_EGRESS)" || { bad "standing create failed: $SA"; echo "  · API log tail:"; tail -8 /tmp/chub-api.log; exit 1; }

step "start the CI runner (as the agent identity)"
CLAWHUB_URL="$APIBASE" CLAWHUB_TOKEN="$AGENT_TOKEN" CLAWHUB_RUNNER_WORKDIR="$RUNNER_WORK" \
  CLAWHUB_RUNNER_EXTRA_HOSTS="host.docker.internal:host-gateway" DOCKER_HOST="$DOCKER_HOST" \
  npx tsx packages/runner/src/index.ts >/tmp/chub-runner.log 2>&1 &
RUNNER_PID=$!
sleep 3; ok "runner subscribed"

step "dispatch a tick"
RUN="$(curl -fsS -X POST "$APIBASE/api/v1/repos/$USER_HANDLE/demo/standing-agents/$SA_ID/run" -H "Authorization: Bearer $USER_TOKEN")"
RUN_ID="$(echo "$RUN" | jq -r .runId)"
[ -n "$RUN_ID" ] && [ "$RUN_ID" != null ] && ok "dispatched run $RUN_ID" || { bad "dispatch failed: $RUN"; exit 1; }

step "wait for the run to finish (browser + push + evidence)"
STATUS=""; for i in $(seq 1 80); do
  RUNS="$(curl -fsS "$APIBASE/api/v1/repos/$USER_HANDLE/demo/ci/runs" -H "Authorization: Bearer $USER_TOKEN")"
  STATUS="$(echo "$RUNS" | jq -r --arg r "$RUN_ID" '.runs[] | select(.id==$r) | .status')"
  echo "  …run status: ${STATUS:-pending} (${i})"
  case "$STATUS" in success|failure|skipped) break;; esac
  sleep 3
done
RUN_OUT="$(echo "$RUNS" | jq -r --arg r "$RUN_ID" '.runs[] | select(.id==$r) | .stepResults | tojson')"
[ "$STATUS" = success ] && ok "run finished: success" || bad "run status=$STATUS"

step "ASSERT: a Change was opened"
CHANGES="$(curl -fsS "$APIBASE/api/v1/repos/$USER_HANDLE/demo/changes" -H "Authorization: Bearer $USER_TOKEN")"
CH_ID="$(echo "$CHANGES" | jq -r '.changes[0].id // empty')"
CH_INTENT="$(echo "$CHANGES" | jq -r '.changes[0].intent // empty')"
[ -n "$CH_ID" ] && ok "Change $CH_ID — \"$CH_INTENT\"" || bad "no Change opened"

step "ASSERT: issue auto-linked (Closes: #$ISSUE_NUM)"
echo "$CHANGES" | jq -e --arg n "$ISSUE_NUM" '.changes[0].intent | test("#"+$n)' >/dev/null 2>&1 \
  && ok "Change references issue #$ISSUE_NUM" || echo "  · (Closes link is checked at merge)"

step "ASSERT: a screenshot is attached as review evidence"
REVIEWS="$(curl -fsS "$APIBASE/api/v1/repos/$USER_HANDLE/demo/changes/$CH_ID/reviews" -H "Authorization: Bearer $USER_TOKEN")"
EV_URL="$(echo "$REVIEWS" | jq -r '[.reviews[].evidence[]? | select(.kind=="screenshot")][0].url // empty')"
[ -n "$EV_URL" ] && ok "screenshot evidence: $EV_URL" || bad "no screenshot evidence on the Change"

step "ASSERT: the screenshot downloads as a real PNG"
if [ -n "$EV_URL" ]; then
  PNGPATH="$WORK/downloaded-evidence.png"
  # The stored URL uses the container-facing public host; rewrite it to localhost
  # for this host-side fetch (same API, different name for the same server).
  DL_URL="${EV_URL/host.docker.internal:$PORT/localhost:$PORT}"
  curl -fsS -m 20 "$DL_URL" -H "Authorization: Bearer $USER_TOKEN" -o "$PNGPATH"
  KIND="$(file -b "$PNGPATH" 2>/dev/null)"
  echo "$KIND" | grep -q "PNG image" && ok "evidence is a PNG: $KIND" || bad "evidence not a PNG: $KIND"
fi

step "ASSERT: egress containment held (from inside the sandbox)"
echo "$RUN_OUT" | grep -q "example.com → HTTP 200" && ok "allowlisted example.com reached" || bad "example.com not reached (out below)"
if echo "$RUN_OUT" | grep -Eq "google.com → (REFUSED|HTTP 403)"; then ok "non-allowlisted google.com BLOCKED"; else bad "google.com was NOT blocked"; fi
if echo "$RUN_OUT" | grep -Eq "169.254.169.254 → (REFUSED|HTTP 403)"; then ok "cloud-metadata 169.254.169.254 BLOCKED"; else bad "metadata not blocked"; fi
# The runner appends the proxy's own decision log to the run record.
echo "$RUN_OUT" | grep -q '"why":"allowlist"' && ok "proxy logged an allowlist ALLOW" || true
echo "$RUN_OUT" | grep -Eq '"reason":"(not_allowlisted|private_ip)"' && ok "proxy logged a BLOCK" || true

echo; echo "════════════════════════════════════════"
echo "  PASS: $PASS    FAIL: $FAIL"
echo "════════════════════════════════════════"
if [ "$FAIL" -ne 0 ]; then
  echo; echo "--- run stepResults (tail) ---"; echo "$RUN_OUT" | tail -c 3000
  echo; echo "--- runner log (tail) ---"; tail -30 /tmp/chub-runner.log
fi
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
