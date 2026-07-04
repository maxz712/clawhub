#!/bin/sh
# Pull-based self-update for an OFFLOAD CI-runner node — the debian amd64 runner is
# the case that motivated it. The OCI box runs scripts/self-deploy.sh on merge (it
# rebuilds ITS own runner + the api/dashboard), but it CANNOT reach an offload node
# behind NAT: the offload node dials OUT to the OCI API/SSE, OCI can't dial in. So an
# offload runner must pull its own updates. A systemd timer runs this every few
# minutes: fetch master, and if it advanced, fast-forward the checkout, rebuild the
# runner dist (the SAME `npm -w @clawhub/runner run build` self-deploy uses), and
# bounce the runner when idle. This is what makes the deploy fully hands-off on BOTH
# nodes — no manual per-merge runner update.
#
# One-time bootstrap on a node (installs the timer that then runs THIS script):
#   scripts/runner-selfupdate.sh --install
# Env: CLAWHUB_RUNNER_REPO (checkout dir, default $HOME/clawhub).
set -e
REPO="${CLAWHUB_RUNNER_REPO:-$HOME/clawhub}"

# --- one-time bootstrap: fix the git remote to a reachable host + install the timer.
if [ "${1:-}" = "--install" ]; then
  cd "$REPO"
  # The offload checkout is often cloned with a localhost API URL (unreachable off the
  # OCI box). Rewrite the origin HOST to the public API, KEEPING the embedded token.
  cur="$(git remote get-url origin)"
  case "$cur" in
    *localhost:3000*|http://*) new="$(printf '%s' "$cur" | sed 's#http://#https://#; s#localhost:3000#api.useclawhub.com#')"
      git remote set-url origin "$new"; echo "origin host -> api.useclawhub.com (token preserved)" ;;
  esac
  # Copy THIS script out-of-repo so `git reset --hard` in the checkout can never
  # delete the running updater, then install a root-independent user-owned timer.
  install -m 0755 "$REPO/scripts/runner-selfupdate.sh" "$HOME/clawhub-runner-selfupdate.sh"
  UNIT_DIR="/etc/systemd/system"
  sudo tee "$UNIT_DIR/clawhub-runner-selfupdate.service" >/dev/null <<UNIT
[Unit]
Description=ClawHub offload runner self-update (pull latest master, rebuild, bounce)
After=network-online.target
[Service]
Type=oneshot
User=$(id -un)
Environment=CLAWHUB_RUNNER_REPO=$REPO
ExecStart=/bin/sh $HOME/clawhub-runner-selfupdate.sh
UNIT
  sudo tee "$UNIT_DIR/clawhub-runner-selfupdate.timer" >/dev/null <<UNIT
[Unit]
Description=Run the ClawHub offload runner self-update periodically
[Timer]
OnBootSec=2min
OnUnitActiveSec=${CLAWHUB_SELFUPDATE_INTERVAL:-3min}
[Install]
WantedBy=timers.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now clawhub-runner-selfupdate.timer
  echo "installed clawhub-runner-selfupdate.timer (every ${CLAWHUB_SELFUPDATE_INTERVAL:-3min})"
  exit 0
fi

cd "$REPO"
git fetch -q origin master || { echo "selfupdate: fetch failed (transient?) — skipping this tick"; exit 0; }
LOCAL="$(git rev-parse HEAD)"; REMOTE="$(git rev-parse origin/master)"
[ "$LOCAL" = "$REMOTE" ] && exit 0        # already current — the common no-op case

echo "runner-selfupdate: $(printf %.10s "$LOCAL") -> $(printf %.10s "$REMOTE")"
git reset --hard origin/master

# Rebuild the runner dist (tsc). Same as self-deploy on OCI. If deps changed, a plain
# build fails on a missing module → npm install then retry once.
LOG=/tmp/clawhub-runner-selfupdate.log
if ! nice -n 19 npm -w @clawhub/runner run build >"$LOG" 2>&1; then
  echo "runner-selfupdate: build failed — running npm install then retrying"
  npm install >>"$LOG" 2>&1 || true
  nice -n 19 npm -w @clawhub/runner run build >>"$LOG" 2>&1 \
    || { echo "runner-selfupdate: build STILL failing — runner stays on old dist. Tail: $(tail -3 "$LOG" | tr '\n' ' ')"; exit 1; }
fi

# Bounce only when idle (no run sandbox up) so we don't kill an in-flight CI/agent
# run. A killed run is re-dispatched (at-least-once + atomic claim), but avoid the
# churn — the dist is already rebuilt, so the next tick bounces once idle.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qE '^clawhub-(prx|egr|run|build|agent)'; then
  echo "runner-selfupdate: runner busy — dist rebuilt, deferring bounce to the next tick"
  exit 0
fi
pkill -f 'runner/dist/index.js' 2>/dev/null || true   # systemd Restart=always respawns with the new dist
echo "runner-selfupdate: bounced runner -> now on $(printf %.10s "$REMOTE")"
