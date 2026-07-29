#!/bin/sh
# Fuse the per-arch tags (:<sha>-amd64 + :<sha>-arm64) into the multi-arch :latest (+ :<sha>),
# DAEMONLESS via regctl (a static binary) — no docker. Runs as step 2 of the build-harness-amd64
# pipeline (`execution: build`, contained) AFTER its own amd64 build, polling for the arm64 tag
# the other pipeline pushes in parallel. HARD-FAILS if either arch is missing — :latest must
# never point at a single-arch (half-built) manifest. See docs/operations.md.
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
# regctl image. wget remains as a last resort for unproxied/non-sandbox environments.
REGCTL="$(command -v regctl || echo ./regctl)"
if [ ! -x "$REGCTL" ] && command -v buildctl-daemonless.sh >/dev/null 2>&1; then
  RD="$(mktemp -d 2>/dev/null || echo /tmp/regctl-fetch)"; mkdir -p "$RD"
  printf 'FROM %s AS src\nFROM scratch\nCOPY --from=src /regctl /regctl\n' "${REGCTL_IMAGE:-ghcr.io/regclient/regctl:latest}" > "$RD/Dockerfile"
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

# Wait for BOTH per-arch tags (parallel native builds; arm64 on the 2-core box is the long pole).
deadline=$(( $(date +%s) + ${HARNESS_MANIFEST_TIMEOUT:-3000} ))
for arch in amd64 arm64; do
  until "$REGCTL" manifest head "$REPO:$SHA-$arch" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "FATAL: $REPO:$SHA-$arch never appeared within timeout — NOT updating :latest (would be single-arch). Check build-harness-$arch."
      exit 1
    fi
    echo "waiting for $REPO:$SHA-$arch ..."
    sleep 20
  done
done

echo "both arches present — fusing multi-arch manifest for $IMAGE (+ $REPO:$SHA)"
"$REGCTL" index create "$IMAGE"     --ref "$REPO:$SHA-amd64" --ref "$REPO:$SHA-arm64"
"$REGCTL" index create "$REPO:$SHA" --ref "$REPO:$SHA-amd64" --ref "$REPO:$SHA-arm64"
echo "published multi-arch $IMAGE (+ $REPO:$SHA)"
