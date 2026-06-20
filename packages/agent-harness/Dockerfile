# ClawHub reference agent harness.
#
# A BYO standing-agent / role container that implements the ClawHub contract:
# reads CLAWHUB_* env, runs Claude Code headless for the cognition, and does the
# ClawHub-specific plumbing (magic-ref push, review submit, memory write-back).
# ClawHub never runs the model — THIS container does, with YOUR key.
#
# Build:   docker build -t clawhub-agent-harness packages/agent-harness
# Deploy:  ch role create --template worker ... (defaults to this image), or
#          ch standing add ... --image <your-registry>/clawhub-agent-harness
#
# Multi-arch (the OCI free box is arm64): docker buildx build --platform linux/amd64,linux/arm64 ...
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/*

# Claude Code headless (the agent loop). Swap for Aider / your own loop by editing
# entrypoint.sh — the contract is the same.
RUN npm install -g @anthropic-ai/claude-code @clawhub/cli 2>/dev/null || npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
COPY entrypoint.sh /usr/local/bin/clawhub-harness
RUN chmod +x /usr/local/bin/clawhub-harness

# The runner mounts the cloned repo at /workspace and runs this entrypoint.
ENTRYPOINT ["/usr/local/bin/clawhub-harness"]
