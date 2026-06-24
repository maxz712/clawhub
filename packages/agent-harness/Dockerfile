# ClawHub reference agent harness — now with browser hands.
#
# A BYO standing-agent / role container that implements the ClawHub contract:
# reads CLAWHUB_* env, runs Claude Code headless for the cognition, and does the
# ClawHub-specific plumbing (magic-ref push, review submit, memory write-back,
# AND browser-driven UI testing + screenshot evidence). ClawHub never runs the
# model — THIS container does, with YOUR key.
#
# Build:   docker build -t clawhub-agent-harness packages/agent-harness
# Deploy:  ch role create --template worker ... (defaults to this image), or
#          ch standing add ... --image <your-registry>/clawhub-agent-harness
#
# The browser (Playwright + Chromium, baked in) lets an agent open the app it
# just built, click around, and screenshot what it implemented as PR evidence.
# All of that egress is contained by the runner's per-run proxy — see
# packages/runner/egress-proxy.cjs.
#
# Based on the official Playwright image so Chromium + its system libs are
# present and version-matched. Multi-arch: docker buildx build --platform ...
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

# git for push, jq+curl for the ClawHub API plumbing.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/*

# Harness deps live in /opt/harness so bare `import "playwright"` from our scripts
# resolves regardless of the workspace. The browsers are already in /ms-playwright.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/harness
RUN npm init -y >/dev/null 2>&1 && npm install playwright@1.48.0 \
    && (npm install -g @anthropic-ai/claude-code @clawhub/cli 2>/dev/null \
        || npm install -g @anthropic-ai/claude-code || true)

# The browser driver + the ClawHub plumbing + the entrypoint.
COPY browse.mjs /opt/harness/browse.mjs
COPY clawhub-evidence /usr/local/bin/clawhub-evidence
COPY entrypoint.sh /usr/local/bin/clawhub-harness
RUN printf '#!/bin/sh\nexec node /opt/harness/browse.mjs "$@"\n' > /usr/local/bin/clawhub-browse \
    && chmod +x /usr/local/bin/clawhub-browse /usr/local/bin/clawhub-evidence /usr/local/bin/clawhub-harness

# The runner mounts the cloned repo at /workspace and runs this entrypoint.
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/clawhub-harness"]
