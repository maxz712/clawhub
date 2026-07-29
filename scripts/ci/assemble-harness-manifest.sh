#!/bin/sh
# Fuse the per-arch tags (:<sha>-amd64 + :<sha>-arm64) into the multi-arch :latest (+ :<sha>),
# DAEMONLESS via regctl (a static binary) — no docker. Runs as step 2 of BOTH build-harness
# pipelines (`execution: build`, contained) after each leg's own push; whichever leg pushes
# LAST sees both tags and performs the fuse (see the last-leg-wins block below). :latest is
# only ever written with BOTH arches present — never a single-arch (half-built) manifest.
# See docs/operations.md.
set -e
IMAGE="${CLAWHUB_HARNESS_IMAGE:-ghcr.io/maxz712/clawhub-agent-harness:latest}"
REPO="${IMAGE%:*}"
REGISTRY="${IMAGE%%/*}"
# Bypass dubious ownership checks in rootless sandbox
git config --global --add safe.directory /workspace 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true

SHA="$( git rev-parse --short HEAD 2>/dev/null || printf '%s' "${CLAWHUB_COMMIT:-dev}" | cut -c1-7 )"

# ONE definition of "the harness image changed", shared with assemble-harness-manifest.sh
# (they drifted once and silently half-published; see scripts/ci/harness-sources.sh).
. "$(dirname "$0")/harness-sources.sh" 2>/dev/null || HARNESS_SOURCE_RE='^(packages/agent-harness/|scripts/(ci/)?build-harness|scripts/ci/assemble-harness|\.clawhub/ci/build-harness)'

# Same self-filter as the builds — nothing to fuse if the harness did not change (git-optional).
if command -v git >/dev/null 2>&1 && git rev-parse HEAD~1 >/dev/null 2>&1 \
   && ! git diff --name-only HEAD~1 HEAD | grep -qE "$HARNESS_SOURCE_RE"; then
  echo "no packages/agent-harness/** changes in $SHA — nothing to assemble"
  exit 0
fi

# Which leg are we? (both pipelines run this script; see last-leg-wins below)
case "$(uname -m)" in
  x86_64|amd64) OWN_ARCH=amd64; SIBLING_ARCH=arm64 ;;
  aarch64|arm64) OWN_ARCH=arm64; SIBLING_ARCH=amd64 ;;
  *) echo "FATAL: unrecognized arch $(uname -m)"; exit 1 ;;
esac

# Auth: regctl reads ~/.docker/config.json (the build step wrote it; write here too for safety).
if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
  mkdir -p "$HOME/.docker"
  printf '{"auths":{"%s":{"auth":"%s"}}}' "$REGISTRY" "$(printf '%s:%s' "$GHCR_USER" "$GHCR_TOKEN" | base64 | tr -d '\n')" > "$HOME/.docker/config.json"
fi

# regctl: static, daemonless manifest ops. Use it from PATH; else EXTRACT it from the
# official image via buildctl. Why not wget: this step runs in the rootless-BuildKit
# sandbox behind the egress proxy, whose TLS policy is CONNECT-only (end-to-end TLS —
# packages/runner/egress-proxy.cjs rejects an absolute-form https GET with 400 BY
# DESIGN), and busybox wget cannot speak CONNECT — so the old
# `wget https://github.com/...` 400'd on EVERY sandboxed run and the fuse never
# published (proven live, run c813e96d: both arches built + pushed, :latest stayed
# stale). buildctl is the one fetcher PROVEN to traverse the proxy here (it pushed the
# per-arch images moments earlier), so use it to COPY the static binary out of the
# regctl image, PINNED (#94) to the exact version proven live in this sandbox —
# a :latest drift can't silently change the manifest tool under CI. Override via
# REGCTL_IMAGE. wget remains as a last resort for unproxied/non-sandbox environments.
REGCTL="$(command -v regctl || echo ./regctl)"
if [ ! -x "$REGCTL" ] && command -v buildctl-daemonless.sh >/dev/null 2>&1; then
  RD="$(mktemp -d 2>/dev/null || echo /tmp/regctl-fetch)"; mkdir -p "$RD"
  printf 'FROM %s AS src\nFROM scratch\nCOPY --from=src /regctl /regctl\n' "${REGCTL_IMAGE:-ghcr.io/regclient/regctl:v0.11.5}" > "$RD/Dockerfile"
  # Separate step = separate shell: the build step's exported BUILDKITD_FLAGS do NOT
  # reach this script, so set the same rootless+snapshotter flags here.
  export BUILDKITD_FLAGS="${BUILDKITD_FLAGS:---oci-worker-no-process-sandbox --oci-worker-snapshotter=${CLAWHUB_BUILDKIT_SNAPSHOTTER:-overlayfs}}"
  if buildctl-daemonless.sh build --frontend dockerfile.v0 --local context="$RD" --local dockerfile="$RD" \
       --output "type=local,dest=$RD/out" >/dev/null 2>&1 && [ -e "$RD/out/regctl" ]; then
    cp "$RD/out/regctl" ./regctl && chmod +x ./regctl && REGCTL=./regctl
    echo "regctl extracted via buildctl ($("$REGCTL" version 2>/dev/null | head -1 || echo version unknown))"
  else
    echo "WARNING: buildctl-based regctl extraction failed — falling back to wget (will not work behind the CONNECT-only egress proxy)"
  fi
fi
if [ ! -x "$REGCTL" ]; then
  a="$(uname -m)"; case "$a" in x86_64) a=amd64 ;; aarch64) a=arm64 ;; esac
  wget -qO ./regctl "https://github.com/regclient/regclient/releases/latest/download/regctl-linux-$a"
  chmod +x ./regctl; REGCTL=./regctl
fi

# LAST-LEG-WINS fuse (both pipelines run this as step 2, after their own push).
# The old design had ONLY the amd64 leg fuse, long-polling for the arm64 tag — but the
# arm64 leg queues on the 2-core prod box behind deploys + agent runs, and was observed
# starting 54 MINUTES after the merge, so the poll timed out while a healthy build sat
# pending, and the polling itself pinned the amd64 runner for the whole wait. Instead:
# each leg checks for its SIBLING after its OWN push. The last leg to push always sees
# both tags and fuses; the earlier leg exits 0 trusting its sibling. Race-free by
# construction (check-after-own-push), and a double-fuse is idempotent (same refs, same
# index). A missing sibling is NOT a failure here — if that leg is broken, its own run
# reports the failure; :latest is simply not updated (never single-arch).
deadline=$(( $(date +%s) + ${HARNESS_MANIFEST_TIMEOUT:-90} ))
if ! "$REGCTL" manifest head "$REPO:$SHA-$OWN_ARCH" >/dev/null 2>&1; then
  echo "FATAL: our own tag $REPO:$SHA-$OWN_ARCH is not on the registry — the build step should have pushed it"
  exit 1
fi
until "$REGCTL" manifest head "$REPO:$SHA-$SIBLING_ARCH" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "sibling tag $REPO:$SHA-$SIBLING_ARCH not pushed yet — exiting 0; the $SIBLING_ARCH leg fuses when it lands (last leg wins). :latest is NOT updated by this leg."
    exit 0
  fi
  echo "brief wait for $REPO:$SHA-$SIBLING_ARCH (registry propagation grace) ..."
  sleep 15
done

echo "both arches present — fusing multi-arch manifest for $IMAGE (+ $REPO:$SHA)"
"$REGCTL" index create "$IMAGE"     --ref "$REPO:$SHA-amd64" --ref "$REPO:$SHA-arm64"
"$REGCTL" index create "$REPO:$SHA" --ref "$REPO:$SHA-amd64" --ref "$REPO:$SHA-arm64"
echo "published multi-arch $IMAGE (+ $REPO:$SHA)"
