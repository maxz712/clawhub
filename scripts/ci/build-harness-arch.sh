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
# Bypass dubious ownership checks in rootless BuildKit sandbox
git config --global --add safe.directory /workspace 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true

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
   && ! git diff --name-only HEAD~1 HEAD | grep -qE '^(packages/agent-harness/|scripts/(ci/)?build-harness)'; then
  # The BUILD SCRIPTS are harness-image sources too: a fix to this file or to
  # build-harness.sh changes how the image is produced, so it must be able to
  # trigger its own rebuild (otherwise a build fix can never take effect —
  # nothing would rebuild until some unrelated harness edit came along).
  # self-deploy.sh's HARNESS_CHANGED already counts scripts/build-harness.sh.
  echo "no harness-image source changes in $SHA (packages/agent-harness/**, scripts/**build-harness*) — skipping $ARCH build"
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

# Pass HTTP_PROXY and HTTPS_PROXY build arguments if present in the environment
# so the nested RUN steps can traverse the container's egress proxy.
# …but the proxy URL the runner hands us is a Docker-internal container NAME
# (`http://clawhub-prx-<runid>:8080`, see packages/runner egress sandbox), and the
# RUN steps' resolv.conf was just pinned to PUBLIC resolvers — which by
# construction can NEVER resolve an internal Docker name. The two mitigations
# (pin public DNS so the mirrors resolve; route RUN through the egress proxy)
# silently cancelled each other: every apt/curl/npm fetch died with "Temporary
# failure resolving 'clawhub-prx-…'", the apt retry loop burned ~25 min, and the
# run hit the 1800s timeout. That is the harness build failing on BOTH legs.
#
# Fix: resolve the proxy's name to an IP *here* — this script runs in the run
# container, which DOES have Docker's embedded resolver (127.0.0.11) — and hand
# the RUN steps an IP. Then RUN needs no DNS at all to reach the proxy, and the
# proxy (which sits on the bridge network with working DNS) resolves the upstream
# mirrors itself. The public-DNS pin stays for the no-proxy case.
proxy_as_ip() { # proxy_as_ip URL → URL with the host replaced by its IP (unchanged on failure)
  _url="$1"
  _hostport="${_url#*://}"; _hostport="${_hostport%%/*}"
  _host="${_hostport%%:*}"; _port="${_hostport##*:}"
  [ "$_port" = "$_host" ] && _port=""
  case "$_host" in
    *[!0-9.]*) : ;;                       # contains a letter → an internal name, resolve it
    *) printf '%s' "$_url"; return 0 ;;   # already numeric → nothing to do
  esac
  _ip="$(getent hosts "$_host" 2>/dev/null | awk 'NR==1{print $1}')"
  [ -n "$_ip" ] || _ip="$(nslookup "$_host" 2>/dev/null | awk '/^Address/{a=$NF} END{print a}')"
  if [ -n "$_ip" ]; then
    printf 'http://%s%s' "$_ip" "${_port:+:$_port}"
  else
    echo "WARNING: could not resolve egress proxy host '$_host' to an IP — RUN steps will get the NAME and will likely fail DNS (see the pinned resolvers above)" >&2
    printf '%s' "$_url"
  fi
}

PROXY_ARGS=""
if [ -n "${HTTP_PROXY:-}" ]; then
  HTTP_PROXY_IP="$(proxy_as_ip "$HTTP_PROXY")"
  echo "egress proxy for RUN steps: $HTTP_PROXY -> $HTTP_PROXY_IP"
  PROXY_ARGS="$PROXY_ARGS --opt build-arg:HTTP_PROXY=$HTTP_PROXY_IP --opt build-arg:http_proxy=$HTTP_PROXY_IP"
fi
if [ -n "${HTTPS_PROXY:-}" ]; then
  HTTPS_PROXY_IP="$(proxy_as_ip "$HTTPS_PROXY")"
  PROXY_ARGS="$PROXY_ARGS --opt build-arg:HTTPS_PROXY=$HTTPS_PROXY_IP --opt build-arg:https_proxy=$HTTPS_PROXY_IP"
fi

echo "building $REPO:$SHA-$ARCH natively on $host via rootless BuildKit (DNS pinned via $BK_CONF)"
buildctl-daemonless.sh build \
  --frontend dockerfile.v0 \
  --local context=packages/agent-harness \
  --local dockerfile=packages/agent-harness \
  $PROXY_ARGS \
  --output "type=image,name=$REPO:$SHA-$ARCH,push=true"
echo "pushed $REPO:$SHA-$ARCH"
