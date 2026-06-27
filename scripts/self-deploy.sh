#!/bin/sh
# Self-deploy: executed by the ClawHub CI runner on the production host when
# a Change merges to master (`on: merge` pipeline). The runner runs us inside
# a clone checked out at the merge commit, so HEAD here is exactly what
# landed. The live checkout in ~/clawhub is updated to that commit and the
# stack rebuilt. Secrets live in ~/clawhub/.env, which is untracked and
# therefore untouched by the reset.
set -e
COMMIT=$(git rev-parse HEAD)
echo "deploying $COMMIT"

cd "$HOME/clawhub"
git fetch -q origin
git reset --hard -q "$COMMIT"

# Stamp the image with what we are deploying — /health reports it.
GIT_SHA=$COMMIT
export GIT_SHA

docker compose --profile proxy build api dashboard
docker compose --profile proxy up -d

# The API restart races our own status report; the runner retries terminal
# reports for a minute, but still verify the new container actually serves.
i=0
until wget -qO /dev/null http://localhost:3000/api/v1/health; do
  i=$((i + 1))
  [ "$i" -ge 20 ] && echo "health check failed after deploy" && exit 1
  sleep 3
done
echo "health ok"

# Rebuild + publish the agent-harness image so deployed verify-mode reviewers +
# multi-CLI standing agents pull an image that matches the source (verify mode +
# the four CLIs live in THIS image, not the api/dashboard ones built above).
# Opt-in (needs `docker buildx` + registry push creds on the host) and best-effort
# — a harness build failure must NOT fail an otherwise-good deploy, but it's loud.
if [ "${CLAWHUB_BUILD_HARNESS:-0}" = "1" ]; then
  if sh "$HOME/clawhub/scripts/build-harness.sh"; then
    echo "agent-harness image republished"
  else
    echo "WARNING: agent-harness image build/publish FAILED — verify-mode agents may run a stale image. Check buildx + registry creds, then run scripts/build-harness.sh."
  fi
fi

# The CI runner is a SEPARATE systemd unit (clawhub-runner → packages/runner/
# dist/index.js), NOT a compose service — so runner-code changes (e.g. the
# Change-ref fetch that lets verify/CI runs check out an agent-opened Change, or
# the per-CLI egress hosts) do NOT ship with the compose build above. Rebuild its
# dist from the just-merged source and bounce it: `pkill` + systemd Restart=always
# respawns it with the new code and a fresh env, no sudo (see docs/operations.md).
# Best-effort: a runner rebuild failure must NOT fail an otherwise-good deploy, but
# it is loud (a stale runner silently breaks verify runs + refs/for CI checkouts).
if [ -f packages/runner/package.json ]; then
  if npm -w @clawhub/runner run build >/tmp/clawhub-runner-build.log 2>&1; then
    pkill -f 'runner/dist/index.js' 2>/dev/null || true
    echo "clawhub-runner rebuilt + bounced (systemd respawns it)"
  else
    echo "WARNING: clawhub-runner rebuild FAILED — runner-code changes are NOT live (verify runs + refs/for CI checkouts will break). Tail: $(tail -3 /tmp/clawhub-runner-build.log 2>/dev/null | tr '\n' ' ')"
  fi
fi

# Mirror the merged trunk to GitHub. Best-effort: a mirror failure must NOT fail
# the deploy — but it must not be SILENT either. A swallowed failure drifts the
# public mirror behind prod for an entire deploy cycle with nobody noticing
# (exactly what happened after the OCI cutover: the host had no GitHub push
# creds, so every deploy's `2>/dev/null` push failed invisibly).
if git remote get-url github >/dev/null 2>&1; then
  # Trust github.com's host key (non-secret) so a fresh host doesn't fail the
  # very first push with "Host key verification failed".
  mkdir -p "$HOME/.ssh"
  if ! ssh-keygen -F github.com >/dev/null 2>&1; then
    ssh-keyscan -t rsa,ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
  fi
  if git push -q github master 2>/tmp/clawhub-mirror.err; then
    echo "github mirror updated -> $COMMIT"
  else
    # Loud + actionable. Deploy already succeeded; surface the divergence.
    echo "WARNING: github mirror push FAILED — deploy succeeded but prod ($COMMIT) is now AHEAD of the public mirror."
    echo "  reason: $(grep -v '^[[:space:]]*$' /tmp/clawhub-mirror.err 2>/dev/null | tail -2 | tr '\n' ' ')"
    echo "  fix: provision GitHub push creds for the 'github' remote on this host (deploy key in ~/.ssh or a PAT),"
    echo "       then re-sync once with:  git -C $HOME/clawhub push github master"
  fi
else
  echo "github mirror skipped (no 'github' remote configured)"
fi
