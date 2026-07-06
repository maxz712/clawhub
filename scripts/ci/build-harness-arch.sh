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

# Self-filter (skips non-harness merges). When the sandbox image LACKS git the
# filter cannot run — the old fallback was "just build", which meant EVERY merge
# rebuilt the harness on that node, tagged it :dev-<arch> (no sha), and a single
# apt blip failed the merge's CI for an image nobody asked for (live 2026-07-06,
# run 25dd25d1). Fail SAFE instead: skip loudly. A genuine harness change still
# builds wherever git exists (the other arch leg), and the right fix for this
# node is a build image with git; CLAWHUB_FORCE_HARNESS_BUILD=1 overrides.
if ! command -v git >/dev/null 2>&1; then
  if [ "${CLAWHUB_FORCE_HARNESS_BUILD:-}" = "1" ]; then
    echo "WARNING: no git in the build image — cannot self-filter; building because CLAWHUB_FORCE_HARNESS_BUILD=1"
  else
    echo "WARNING: no git in the build image — cannot tell if $SHA touches packages/agent-harness/**; SKIPPING the $ARCH build (set CLAWHUB_FORCE_HARNESS_BUILD=1 to build anyway, or add git to the build image)"
    exit 0
  fi
elif git rev-parse HEAD~1 >/dev/null 2>&1 \
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
# DNS fix — the ROOT of the intermittent apt failures in this sandbox. BuildKit's
# rootless RUN steps (the Dockerfile's apt-get/curl/npm) resolve the apt mirrors
# DIRECTLY: they do NOT inherit the container's HTTP_PROXY, and the per-run egress proxy
# sits on the `--internal` Docker network — a DIFFERENT netns than the rootless RUN
# network — so it is not reachable from RUN (the error is "Temporary failure RESOLVING
# archive.ubuntu.com", i.e. RUN is resolving the mirror itself, not going through the
# proxy). RUN does have an outbound path (it reaches the mirrors when DNS happens to
# work), so the flake is purely NAME resolution via the default rootless resolver. Pin
# reliable public resolvers into the RUN steps' resolv.conf via a buildkitd config so
# apt/curl/npm resolve CONSISTENTLY. Safe: it can only make resolution more reliable, it
# never removes the outbound path or forces an unreachable proxy.
BK_CONF="$(mktemp 2>/dev/null || echo /tmp/buildkitd-dns.toml)"
printf '[dns]\n  nameservers = ["1.1.1.1", "8.8.8.8", "9.9.9.9"]\n' > "$BK_CONF"
export BUILDKITD_FLAGS="${BUILDKITD_FLAGS:---oci-worker-no-process-sandbox --oci-worker-snapshotter=native} --config $BK_CONF"

echo "building $REPO:$SHA-$ARCH natively on $host via rootless BuildKit (DNS pinned via $BK_CONF)"
buildctl-daemonless.sh build \
  --frontend dockerfile.v0 \
  --local context=packages/agent-harness \
  --local dockerfile=packages/agent-harness \
  --output "type=image,name=$REPO:$SHA-$ARCH,push=true"
echo "pushed $REPO:$SHA-$ARCH"
