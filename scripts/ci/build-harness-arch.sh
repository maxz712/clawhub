#!/bin/sh
# Native, SINGLE-arch build of the agent-harness image → per-arch tag
# ghcr.io/…/clawhub-agent-harness:<sha>-<arch>, via ROOTLESS BuildKit — NO host docker.
#
# Invoked by the build-harness-<arch> CI pipeline (`execution: build`, `runs_on: <arch>`) so it
# runs CONTAINED in a rootless-BuildKit sandbox on a matching-arch runner: native arch, no QEMU,
# no host docker socket. The manifest step (assemble-harness-manifest.sh) fuses the per-arch
# tags into multi-arch :latest. CI secrets GHCR_USER/GHCR_TOKEN are injected into the env.
#
# NOTE (host go/no-go): whether rootless BuildKit STARTS is kernel-specific — user namespaces
# must be enabled (`unshare -Ur echo ok`). If it can't start on the deploy host, fall back to
# the self-deploy inline build (CLAWHUB_SELFDEPLOY_BUILD_HARNESS=1). See docs/operations.md.
set -e
ARCH="${1:?arch (amd64|arm64) required}"
IMAGE="${CLAWHUB_HARNESS_IMAGE:-ghcr.io/maxz712/clawhub-agent-harness:latest}"
REPO="${IMAGE%:*}"          # strip :tag → repo
REGISTRY="${IMAGE%%/*}"     # ghcr.io
# The rootless-BuildKit image may lack git; fall back to CLAWHUB_COMMIT (the runner checks out
# the merge commit) for the tag when git is unavailable.
SHA="$( git rev-parse --short HEAD 2>/dev/null || printf '%s' "${CLAWHUB_COMMIT:-dev}" | cut -c1-7 )"

# Self-filter — only when git is present (skips non-harness merges). A minimal build image
# without git just builds; the pipeline is already gated to change.merged so this is bounded.
if command -v git >/dev/null 2>&1 && git rev-parse HEAD~1 >/dev/null 2>&1 \
   && ! git diff --name-only HEAD~1 HEAD | grep -qE '^packages/agent-harness/'; then
  echo "no packages/agent-harness/** changes in $SHA — skipping $ARCH build"
  exit 0
fi

# Arch guard: the native build must match the requested arch (runs_on should guarantee it).
host="$(uname -m)"
case "$ARCH:$host" in
  amd64:x86_64|amd64:amd64|arm64:aarch64|arm64:arm64) : ;;
  *) echo "FATAL: build-harness-arch $ARCH dispatched to a $host runner (runs_on routing failed)"; exit 1 ;;
esac

# Registry auth: BuildKit reads ~/.docker/config.json — write it from the GHCR CI secrets
# (base64 of user:token). No `docker login` (there is no docker daemon in a rootless build).
if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
  mkdir -p "$HOME/.docker"
  printf '{"auths":{"%s":{"auth":"%s"}}}' "$REGISTRY" "$(printf '%s:%s' "$GHCR_USER" "$GHCR_TOKEN" | base64 | tr -d '\n')" > "$HOME/.docker/config.json"
fi

# Rootless BuildKit in a locked-down container: no process-sandbox (we're already sandboxed),
# native snapshotter (no /dev/fuse needed). buildctl-daemonless.sh starts buildkitd on demand.
export BUILDKITD_FLAGS="${BUILDKITD_FLAGS:---oci-worker-no-process-sandbox --oci-worker-snapshotter=native}"
echo "building $REPO:$SHA-$ARCH natively on $host via rootless BuildKit"
buildctl-daemonless.sh build \
  --frontend dockerfile.v0 \
  --local context=packages/agent-harness \
  --local dockerfile=packages/agent-harness \
  --output "type=image,name=$REPO:$SHA-$ARCH,push=true"
echo "pushed $REPO:$SHA-$ARCH"
