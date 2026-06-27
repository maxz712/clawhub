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
# registry (e.g. `docker login ghcr.io`). Wired (opt-in) into scripts/self-deploy.sh
# behind CLAWHUB_BUILD_HARNESS=1; also runnable by hand.
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

echo "building $IMAGE (+ $REPO:$SHA) for $PLATFORMS from $DIR"
docker buildx build --platform "$PLATFORMS" \
  -t "$IMAGE" -t "$REPO:$SHA" \
  --push "$DIR"
echo "pushed $IMAGE + $REPO:$SHA"
