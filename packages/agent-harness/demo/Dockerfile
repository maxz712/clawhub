# Deterministic demo agent for verifying ClawHub's browser hands + egress
# containment end-to-end WITHOUT an LLM. Same BYO contract as the reference
# harness; only the entrypoint differs (a scripted flow instead of Claude Code).
#
# Build (after the harness image exists):
#   docker build -t clawhub-agent-harness packages/agent-harness
#   docker build -t clawhub-demo-agent     packages/agent-harness/demo
FROM clawhub-agent-harness
COPY demo-agent.sh /usr/local/bin/clawhub-demo-agent
RUN chmod +x /usr/local/bin/clawhub-demo-agent
ENTRYPOINT ["/usr/local/bin/clawhub-demo-agent"]
