# ClawHub UNIVERSAL agent harness — ONE image for every BYO agent.
#
# A BYO standing-agent / Agent-Role container that implements the ClawHub contract:
# reads CLAWHUB_* env, runs ONE of many coding-agent CLIs headless for the cognition
# (CLAWHUB_CLI: claude | copilot | codex | gemini | aider | cline | goose | cursor |
# continue), against ANY provider (just bring a key — the runner allowlists every
# common AI endpoint and the key is injected under the right env var), and does the
# ClawHub plumbing (magic-ref push, review submit, e2e verification, memory).
#
# Batteries included so users never pick an image:
#   • all the common coding-agent CLIs (best-effort installs; one missing never
#     fails the build),
#   • Playwright + Chromium for browser-driven UI testing + screenshot evidence,
#   • Docker engine + Compose (Docker-in-Docker) so verify mode can BOOT a real
#     multi-service app (Postgres+Redis+…) and test it end-to-end. The runner gives
#     verify runs --privileged; the nested stack stays inside this container and its
#     egress still routes through the per-run proxy. See docs/verified-autonomy.md.
#
# Build:  docker build -t clawhub-agent-harness packages/agent-harness  (multi-arch:
#         docker buildx build --platform linux/amd64,linux/arm64 … or scripts/build-harness.sh)
#
# Based on the official Playwright image so Chromium + its libs are version-matched.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

# System deps: git/jq/curl for the ClawHub plumbing; python+pip for pip-based agents
# (aider); the Docker engine for Docker-in-Docker verify boots.
# Network resilience: the build sandbox occasionally hits a transient DNS blip resolving
# the apt mirrors (archive.ubuntu.com / deb.nodesource.com), which used to fail the whole
# multi-arch harness publish. Tell apt to retry individual fetches AND retry `apt-get
# update` a few times so DNS has time to settle — a network hiccup no longer reds an
# otherwise-good rebuild.
# The `[ "$i" = N ] && exit 1` on the LAST attempt is load-bearing: without it the
# retry loop's `|| { …; sleep; }` exits 0 even when every attempt failed, masking a
# persistent failure as success (a broken image with no git/curl). The final attempt
# hard-fails the build.
RUN printf 'Acquire::Retries "8";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries \
    && for i in 1 2 3 4 5 6; do apt-get update && break || { [ "$i" = 6 ] && echo "apt-get update failed after 6 attempts" && exit 1; echo "apt-get update retry $i…"; sleep 6; }; done \
    && for i in 1 2 3; do apt-get install -y --no-install-recommends \
         git ca-certificates curl jq python3 python3-pip docker.io && break || { [ "$i" = 3 ] && echo "apt-get install failed after 3 attempts" && exit 1; echo "apt-get install retry $i…"; sleep 6; }; done \
    && rm -rf /var/lib/apt/lists/*

# Docker Compose v2 as a CLI plugin (dev stacks use `docker compose`).
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-$(uname -m)" \
         -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose || true

# Harness deps live in /opt/harness so bare `import "playwright"` resolves anywhere.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/harness
# ClawHub's own CLI is the npm package `useclawhub` (bin: `ch`). NOT `@clawhub/cli`,
# which is an unrelated third-party package — installing that here put foreign code
# in the image that holds agent tokens. This install is NOT best-effort: agents rely
# on `ch` (memory writes, issues), so a missing CLI should fail the build loudly.
# Network-resilient (this install is REQUIRED, not best-effort): npm retries transient
# registry/DNS blips instead of failing the publish.
RUN npm config set fetch-retries 6 && npm config set fetch-retry-maxtimeout 120000 && npm config set fetch-retry-mintimeout 5000 \
    && npm init -y >/dev/null 2>&1 && npm install playwright@1.48.0 pixelmatch pngjs \
    && npm install -g useclawhub

# The coding-agent CLIs (CLAWHUB_CLI selects one at run time). Each install is
# best-effort + isolated so one unavailable CLI never fails the build — a deploy
# only needs the CLI it actually selects. Pin majors + re-verify the entrypoint's
# cli_run flags when bumping; these move fast.
RUN npm install -g @anthropic-ai/claude-code || true     # claude  -p --dangerously-skip-permissions
RUN npm install -g @openai/codex || true                 # codex   exec --sandbox danger-full-access -a never
RUN npm install -g @google/gemini-cli || true            # gemini  -p --yolo
RUN npm install -g @github/copilot || true               # copilot -p -s --allow-all-tools
RUN npm install -g cline || true                         # cline   --yolo --json
RUN npm install -g @continuedev/cli || true              # cn      -p --silent
RUN python3 -m pip install --no-cache-dir --break-system-packages aider-chat || true   # aider --message --yes-always (model-agnostic via LiteLLM)

# graphify (graphifyy) — OFFLINE tree-sitter code-graph extraction feeding the memory
# GRAPH layer: develop/reflect drive `clawhub-graph` to map the repo and author
# memory→code / memory→memory edges. Core deps are tree-sitter + networkx/graspologic
# (NO torch/whisper); code extraction needs NO API key (nothing leaves the sandbox).
# Best-effort + isolated so a failed/unavailable install never breaks the build — the
# harness degrades to the agent reading the code itself. See docs/memory.md.
RUN python3 -m pip install --no-cache-dir --break-system-packages graphifyy || true    # graphify extract <dir> (offline, tree-sitter)
RUN (curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash) || true  # goose run -t
RUN (curl -fsS https://cursor.com/install | bash) || true # cursor-agent -p --force
ENV PATH="/root/.local/bin:/root/.cargo/bin:/usr/local/bin:${PATH}"

# Interactive browser MCP — Microsoft's official Playwright MCP (`playwright-mcp`). Gives a
# claude dev/verify agent a LIVE, stateful browser whose snapshot + screenshot the model SEES
# after every action (the perceive→act→perceive loop the batch clawhub-browse can't give).
# OPT-IN at run time via CLAWHUB_BROWSER_MCP=1; the harness falls back to clawhub-browse + Read
# (which uses the base image's own Chromium) when off or unavailable — so this is BEST-EFFORT:
# `|| echo` keeps a failed install/Chromium-bake from ever breaking the build. @playwright/mcp
# pins a NEWER Playwright than the 1.48 base image, so bake the Chromium IT wants into a SEPARATE
# browsers path (/ms-playwright-mcp): installing into /ms-playwright GCs the base image's 1.48
# Chromium that clawhub-browse (the DEFAULT path) needs, which broke browsing entirely. The MCP
# wrapper (clawhub-browser-mcp) exports PLAYWRIGHT_BROWSERS_PATH=/ms-playwright-mcp to find this.
RUN npm install -g @playwright/mcp@0.0.77 \
 && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright-mcp npx --yes playwright@1.62.0-alpha-2026-06-29 install chromium \
 && chmod -R a+rX /ms-playwright-mcp \
 || echo "playwright-mcp unavailable — harness will use the clawhub-browse + Read fallback"

# Keep egress=none clean: silence the CLIs' telemetry / auto-update side-channels so
# they don't try to reach non-essential hosts the proxy would (correctly) block.
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_ERROR_REPORTING=1

# The browser driver + the ClawHub plumbing + the entrypoint.
COPY browse.mjs /opt/harness/browse.mjs
COPY clawhub-graph.mjs /opt/harness/clawhub-graph.mjs
COPY clawhub-evidence /usr/local/bin/clawhub-evidence
COPY clawhub-login /usr/local/bin/clawhub-login
COPY clawhub-browser-mcp /usr/local/bin/clawhub-browser-mcp
COPY entrypoint.sh /usr/local/bin/clawhub-harness
RUN printf '#!/bin/sh\nexec node /opt/harness/browse.mjs "$@"\n' > /usr/local/bin/clawhub-browse \
    && printf '#!/bin/sh\nexec node /opt/harness/clawhub-graph.mjs "$@"\n' > /usr/local/bin/clawhub-graph \
    && chmod +x /usr/local/bin/clawhub-browse /usr/local/bin/clawhub-graph /usr/local/bin/clawhub-evidence /usr/local/bin/clawhub-login /usr/local/bin/clawhub-browser-mcp /usr/local/bin/clawhub-harness

# Run as the unprivileged `pwuser` (uid 1000, shipped by the Playwright image)
# instead of root — defense-in-depth on top of the runner's egress sandbox.
# Own the work + harness dirs so the agent can checkout, install, and write.
RUN mkdir -p /workspace && chown -R pwuser:pwuser /workspace /opt/harness

# The runner mounts the cloned repo at /workspace and runs this entrypoint.
WORKDIR /workspace
USER pwuser
ENTRYPOINT ["/usr/local/bin/clawhub-harness"]
