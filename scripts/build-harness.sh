#!/bin/sh
# Build + publish the reference agent-harness image.
#
# Standing agents and Agent Roles default to CLAWHUB_HARNESS_IMAGE
# (ghcr.io/maxz712/clawhub-agent-harness:latest). That image is what bakes in the
# `verify` mode + the four coding-agent CLIs (claude/copilot/codex/gemini) +
# Playwright/Chromium. If it is NOT republished after packages/agent-harness/**
# changes, deployed verify-mode reviewers pull a STALE image and silently do the
# wrong thing — so this is the build-and-push step that keeps the registry image
# in lockstep with the source.
#
# Requirements on the host: `docker buildx` + push credentials for the target
# registry (e.g. `docker login ghcr.io`). Multi-arch (the default) also needs QEMU
# binfmt registered for the non-native arch — one-time:
#   docker run --privileged --rm tonistiigi/binfmt --install all
# scripts/self-deploy.sh runs this AUTOMATICALLY (no flag) on any merge that changed
# packages/agent-harness/** — multi-arch (amd64+arm64) there, lock released first;
# set CLAWHUB_SKIP_HARNESS=1 to force-skip. Also runnable by hand.
#
# Env:
#   CLAWHUB_HARNESS_IMAGE  target image ref (default ghcr.io/maxz712/clawhub-agent-harness:latest)
#   HARNESS_PLATFORMS      buildx platforms (default linux/amd64,linux/arm64)
set -e

IMAGE="${CLAWHUB_HARNESS_IMAGE:-ghcr.io/maxz712/clawhub-agent-harness:latest}"
PLATFORMS="${HARNESS_PLATFORMS:-linux/amd64,linux/arm64}"
DIR="$(cd "$(dirname "$0")/../packages/agent-harness" && pwd)"
SHA="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"
REPO="${IMAGE%:*}"   # strip the :tag → repo, so we can also push a :<sha> tag

# Multi-platform buildx needs the `docker-container` driver — the default `docker`
# driver builds only the host arch and errors on a comma-list of platforms. Ensure a
# reusable container builder exists (and select it) whenever more than one platform is
# requested. Single-arch builds use whatever builder is active (no container needed).
case "$PLATFORMS" in
  *,*)
    docker buildx inspect clawhub-multiarch >/dev/null 2>&1 \
      || docker buildx create --name clawhub-multiarch --driver docker-container >/dev/null
    BUILDER_FLAG="--builder clawhub-multiarch"
    ;;
  *) BUILDER_FLAG="" ;;
esac

# For a SINGLE-arch build (the self-deploy native path), ALSO publish an
# arch-suffixed tag (:<sha>-<arch>). The build-harness-amd64 CI pipeline fuses a
# multi-arch :latest from :<sha>-amd64 + :<sha>-arm64 — self-deploy publishes THIS
# node's arch tag, the CI pipeline builds + fuses the other. Without it the amd64
# runner can never get a fresh image (the bug that silently killed platform review).
ARCH_TAG=""
case "$PLATFORMS" in
  linux/amd64) ARCH_TAG="-t $REPO:$SHA-amd64" ;;
  linux/arm64) ARCH_TAG="-t $REPO:$SHA-arm64" ;;
esac

echo "building $IMAGE (+ $REPO:$SHA${ARCH_TAG:+ $ARCH_TAG}) for $PLATFORMS from $DIR"
# shellcheck disable=SC2086  # BUILDER_FLAG + ARCH_TAG are intentionally word-split (empty = omitted)
docker buildx build $BUILDER_FLAG --platform "$PLATFORMS" \
  -t "$IMAGE" -t "$REPO:$SHA" $ARCH_TAG \
  --push "$DIR"
echo "pushed $IMAGE + $REPO:$SHA${ARCH_TAG:+ ($ARCH_TAG)}"
