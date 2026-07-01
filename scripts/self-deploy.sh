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

# Every merge to master fires this deploy, and they all share this ONE checkout.
# Two `git fetch` running here at once race on the remote-tracking refs and one
# dies with "cannot lock ref refs/remotes/origin/* — is at X but expected Y",
# which (under `set -e`) aborted the deploy BEFORE the rebuild — so a rapid
# back-to-back merge silently left prod on the older commit. Two guards:
#  1. Serialize deploys behind a lock (when flock is available) so their git ops
#     never overlap; the later deploy waits, then fast-forwards to the newest.
#  2. Never let a remote-tracking-ref lock race abort the deploy: the merge
#     commit's OBJECTS still arrive on a racy fetch (only the local ref update
#     fails), and we hard-reset onto $COMMIT either way. A genuinely missing
#     commit still fails loudly at the reset below.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$HOME/.clawhub-deploy.lock"
  flock -w 600 9 || echo "WARNING: timed out waiting for the deploy lock; proceeding anyway"
fi
git fetch -q origin || git fetch -q origin || echo "WARNING: git fetch reported ref errors (likely a concurrent-deploy ref-lock race); continuing to reset onto $COMMIT"

# Capture the currently-deployed commit BEFORE moving the checkout (the fetch above
# only moved remote-tracking refs, not HEAD) so we can diff exactly what THIS deploy
# changed — which gates the agent-harness image rebuild far below.
PREV=$(git rev-parse HEAD 2>/dev/null || echo "")
git reset --hard -q "$COMMIT"

# Did this deploy touch the agent-harness image sources (its Dockerfile/scripts/CLIs)
# or the build script? Only then do we rebuild + republish the image (below). A
# first/unknown deploy ($PREV empty) rebuilds rather than risk shipping a stale image.
HARNESS_CHANGED=0
if [ -n "$PREV" ] && [ "$PREV" != "$COMMIT" ]; then
  git diff --name-only "$PREV" "$COMMIT" | grep -qE '^(packages/agent-harness/|scripts/build-harness\.sh$)' && HARNESS_CHANGED=1
elif [ -z "$PREV" ]; then
  HARNESS_CHANGED=1
fi

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

# Ensure the agent-harness image is PRESENT on this host, independent of whether it
# changed this deploy. The runner does `docker run <image>` with NO --pull, so a host
# that never pulled it would fail every verify/standing run with "image not found".
# This self-heals that on ANY deploy; the freshness rebuild is gated separately below.
HARNESS_IMAGE="${CLAWHUB_HARNESS_IMAGE:-ghcr.io/maxz712/clawhub-agent-harness:latest}"
if ! docker image inspect "$HARNESS_IMAGE" >/dev/null 2>&1; then
  if docker pull "$HARNESS_IMAGE" >/dev/null 2>&1; then
    echo "harness image pulled onto host -> $HARNESS_IMAGE"
  else
    echo "WARNING: harness image $HARNESS_IMAGE is NOT on this host and the pull FAILED — verify/standing runs will fail 'image not found'. Make the ghcr package public (or add a host pull-login), then: docker pull $HARNESS_IMAGE"
  fi
fi

# (The agent-harness REBUILD now runs at the very end, after the flock is released —
# it is the one heavy/slow step and must not hold the deploy lock. See below.)

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

# --- Agent-harness image: rebuild is now the CI matrix's job; this is BREAK-GLASS ------
# Deployed verify/develop reviewers + multi-CLI standing agents run $HARNESS_IMAGE
# (verify/develop mode + the four CLIs + Playwright/Chromium live in THAT image, not the
# api/dashboard images built above). The PRIMARY publisher is now the build-harness CI
# matrix (.clawhub/ci/build-harness-{amd64,arm64}, on change.merged) — it builds each arch
# NATIVELY on its matching runner (no QEMU) and republishes multi-arch :latest, and the
# runner pulls the image before each run. The always-on presence-pull above still bootstraps
# a host that has never seen the image. This inline build is a BREAK-GLASS fallback (heavy:
# multi-arch via QEMU on this arm64 host) for when the matrix is broken/backlogged — OFF
# unless CLAWHUB_SELFDEPLOY_BUILD_HARNESS=1. It runs LAST, after releasing the deploy flock,
# so a multi-minute build never blocks the next deploy. Best-effort + LOUD.
exec 9>&- 2>/dev/null || true   # release the deploy lock (no-op if flock wasn't held)

if [ "${CLAWHUB_SELFDEPLOY_BUILD_HARNESS:-0}" != "1" ]; then
  [ "$HARNESS_CHANGED" = "1" ] && echo "note: packages/agent-harness/** changed — the build-harness CI matrix (on change.merged) republishes the multi-arch image natively; runners pull it before each run. Set CLAWHUB_SELFDEPLOY_BUILD_HARNESS=1 to ALSO rebuild inline here (break-glass for when the matrix is down)."
elif [ "$HARNESS_CHANGED" = "1" ]; then
  # Break-glass multi-arch: two consumers (OCI arm64 + debian amd64); a single-arch image
  # throws "exec format error" on the other runner. The amd64 leg is QEMU-emulated on this
  # arm64 host — needs binfmt once (`docker run --privileged --rm tonistiigi/binfmt --install all`).
  export HARNESS_PLATFORMS="${HARNESS_PLATFORMS:-linux/amd64,linux/arm64}"
  export CLAWHUB_HARNESS_IMAGE="$HARNESS_IMAGE"
  HARNESS_REGISTRY="${HARNESS_IMAGE%%/*}"
  HAVE_BUILDX=0; docker buildx version >/dev/null 2>&1 && HAVE_BUILDX=1
  HAVE_CREDS=0
  # Explicit push creds (GHCR_USER/GHCR_TOKEN) → a real push-auth check; else fall back to
  # an authenticated registry read implying a usable host login. The fallback is optimistic
  # (a PUBLIC package reads anonymously), so a missing PUSH cred surfaces LOUDLY at push.
  if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
    printf '%s' "$GHCR_TOKEN" | docker login "$HARNESS_REGISTRY" -u "$GHCR_USER" --password-stdin >/dev/null 2>&1 && HAVE_CREDS=1
  fi
  [ "$HAVE_CREDS" = "0" ] && docker buildx imagetools inspect "$HARNESS_IMAGE" >/dev/null 2>&1 && HAVE_CREDS=1
  if [ "$HAVE_BUILDX" = "1" ] && [ "$HAVE_CREDS" = "1" ]; then
    if sh "$HOME/clawhub/scripts/build-harness.sh"; then
      echo "agent-harness image rebuilt + pushed inline ($HARNESS_IMAGE, $HARNESS_PLATFORMS)"
      # buildx --push does NOT --load; refresh this host's cache so its runner uses the new
      # image immediately (other runners get it via their own pull-before-run).
      docker pull "$HARNESS_IMAGE" >/dev/null 2>&1 && echo "local image cache refreshed -> $HARNESS_IMAGE" \
        || echo "WARNING: pushed a new harness image but 'docker pull' FAILED — run: docker pull $HARNESS_IMAGE"
      docker run --rm --entrypoint sh "$HARNESS_IMAGE" -c 'command -v claude >/dev/null && command -v node >/dev/null && test -d /ms-playwright' >/dev/null 2>&1 \
        || echo "WARNING: harness image smoke-check failed (a baked CLI or Chromium may be missing) — inspect the build log."
    else
      echo "WARNING: inline agent-harness build/push FAILED — fix buildx + $HARNESS_REGISTRY push creds (or rely on the CI matrix), then: HARNESS_PLATFORMS=$HARNESS_PLATFORMS scripts/build-harness.sh && docker pull $HARNESS_IMAGE"
    fi
  else
    echo "WARNING: CLAWHUB_SELFDEPLOY_BUILD_HARNESS=1 but cannot rebuild inline (buildx=$HAVE_BUILDX creds=$HAVE_CREDS for $HARNESS_REGISTRY). Install 'docker buildx' + QEMU binfmt and 'docker login $HARNESS_REGISTRY' (or set GHCR_USER/GHCR_TOKEN), or rely on the build-harness CI matrix."
  fi
fi
# HARNESS_CHANGED=0 → nothing to do; the image cannot be stale because nothing changed.
