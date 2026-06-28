# Universal BYO agents — providers, CLIs, and the one image

ClawHub ships **one** agent-harness image (`CLAWHUB_HARNESS_IMAGE`). A user bringing
their own agent never picks an image — they pick a **coding CLI** + a **provider** +
supply **one key**. The platform does the rest: allowlists the provider's endpoint,
injects the key under the env var(s) that CLI/provider reads, and (for verify mode)
gives the container Docker-in-Docker so it can boot the app and test it end-to-end.

ClawHub never runs inference. The model runs inside the user's container with the
user's key; ClawHub orchestrates the hands.

## Coding CLIs (`standing_agents.cli` / `CLAWHUB_CLI`)

Baked into the image, selected per agent. `entrypoint.sh:cli_run` dispatches:

| CLI        | headless invocation                                  | own credential env |
|------------|------------------------------------------------------|--------------------|
| `claude`   | `claude -p … --dangerously-skip-permissions`         | `ANTHROPIC_API_KEY` |
| `codex`    | `codex exec --sandbox danger-full-access -a never …` | `OPENAI_API_KEY` / `CODEX_API_KEY` |
| `gemini`   | `gemini -p … --yolo`                                 | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `copilot`  | `copilot -p … -s --allow-all-tools`                  | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` |
| `cline`    | `cline --yolo --json …`                              | provider vars / `CLINE_API_KEY` |
| `goose`    | `goose run -t …`                                     | provider vars |
| `cursor`   | `cursor-agent -p … --force`                          | `CURSOR_API_KEY` |
| `continue` | `cn -p … --silent`                                   | provider vars / `CONTINUE_API_KEY` |
| `aider`    | `aider --message … --yes-always`                     | provider vars (LiteLLM) |

CLI installs are best-effort in the Dockerfile — one unavailable CLI never fails the
build; a deploy only needs the CLI it selects.

## Providers (`standing_agents.llmProvider` + `llmBaseUrl`)

`standingLlmEnv` (`services/standing-agents.ts`) maps a provider → the env var(s) its
SDK reads + a base URL. Known providers: `openai, anthropic, gemini/google, mistral,
cohere, groq, together, fireworks, deepseek, xai, perplexity, cerebras, hyperbolic,
nvidia, openrouter, requesty, azure, litellm, ollama` — plus `custom` (just
`LLM_API_KEY` + your `llmBaseUrl`) for anything else, incl. self-hosted servers
(Ollama/vLLM/LM Studio/llama.cpp run **inside** the sandbox and need no egress).

OpenAI-compatible providers also get `OPENAI_BASE_URL` pointed at them, so any
OpenAI-SDK-based tool works with just the key.

Auth that is **not** a single bearer string (AWS Bedrock SigV4, Vertex ADC, Azure
endpoint+deployment, Cloudflare authenticated gateways) needs its full env set passed
through `custom` — see the caveats in the source.

## Egress

The runner's `AI_PROVIDER_HOSTS` (`packages/runner/src/index.ts`) is the union of
every common provider/aggregator API host + the CLI auth/telemetry/control-plane
hosts, always reachable as "infra" so a BYO agent on any provider works even under
`egress=none`. Bare registrable domains where per-account/regional subdomains exist
(`amazonaws.com`, `*.azure.com` bases, `githubcopilot.com`, `aiplatform.googleapis.com`).
Loopback/private/metadata are never allowlisted (SSRF guard); the only localhost the
agent reaches is the app it boots itself. Telemetry/auto-update side-channels are
silenced via image ENV (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, etc.) so
`egress=none` stays clean.

## Docker-in-Docker (verify mode)

A `verify`-mode agent gets `--privileged` (set from `sa.mode === "verify"` in
`queuedPayload`, consumed by the runner's `runContainer`). The harness starts a nested
`dockerd` when the `.clawhub/verify.yml` `serve` command uses Docker, so the verifier
can `docker compose up` a real multi-service stack and browser-test it. The nested
stack stays inside the verify container; its egress still NATs out through the per-run
proxy, so containment holds. See [verified-autonomy.md](verified-autonomy.md).
