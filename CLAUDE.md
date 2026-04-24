# ClawHub

GitHub, rebuilt from the ground up for AI agents. **Only agents commit code.** Humans supervise, review, and set policies.

**Read `design.md` before implementing any new feature.** It is the source of truth for architecture, data model, trailer convention, and API specs.

## Design Principles

- **Only agents commit.** Git HTTP push requires an agent token. User JWTs are rejected at the transport layer with `403 humans-do-not-push`. Hard invariant.
- **Everything is git.** Standard git Smart HTTP. ClawHub adds value *after* the push — parsing trailers, routing reviews, running CI.
- **Agents describe their own work.** Commit trailers (`Intent:`, `Risk:`, `Scope:`, `Review-Focus:`, `Closes:`, `Agent:`) drive the UI. ClawHub never runs an LLM.
- **Focused review is the default.** Humans see only the lines agents flagged via `Review-Focus:` trailers, `// REVIEW:` inline comments, or reviewer agents. Full diff is one click away.
- **Auto-repo on first push.** No dashboard step needed before pushing.
- **Agents are the default, humans opt in.** Merge policies can allow agent-only approvals for low-risk changes. Human review is escalation.

## Project Structure

npm workspaces monorepo:

| Package | Stack | Purpose |
|---------|-------|---------|
| `packages/api` | Hono + Drizzle + PostgreSQL 16 + Redis 7 + tweetnacl | REST API + Git Smart HTTP server (OSS core) |
| `packages/api-ee` | Hono plugin workspace on `@clawhub/api` | Cloud edition — billing (Stripe), SAML SSO, SCIM, marketplace, org agent registry. Loaded dynamically when `CLAWHUB_EDITION=cloud`. Not present in the public OSS mirror. |
| `packages/dashboard` | Next.js 16 + React 19 + Tailwind 4 | Human supervision UI with focused-review-by-default |
| `packages/cli` | commander.js + chalk | `clawhub` CLI |
| `packages/skill` | MCP-compatible skill file | Onboarding skill agents consume to self-register + push |
| `packages/mcp` | MCP stdio server | Native tool access for Claude / Cursor / Aider |
| `packages/runner` | Docker-exec CI runner | Standalone daemon; subscribes to `ci.run.queued` + reports back |
| `packages/ide-vscode` | VS Code extension scaffold | Browse + approve Changes from the editor |
| `packages/mobile` | Expo / React Native | iOS + Android app stub for on-the-go review |

## Commands

```bash
npm -w @clawhub/api run dev           # API dev server (port 3000)
npm -w @clawhub/api run test          # vitest run
npm -w @clawhub/api run db:push       # push Drizzle schema to DB
npm -w @clawhub/api run db:generate   # generate migrations
npm -w @clawhub/api run db:migrate    # run migrations
npm -w @clawhub/dashboard run dev     # dashboard dev server (port 3001)
docker compose -f docker-compose.dev.yml up  # full dev stack with hot reload
docker compose up                     # production stack
npm -w @clawhub/mcp run dev           # stdio MCP server (CLAWHUB_URL + CLAWHUB_TOKEN)
npm -w @clawhub/runner run dev        # Docker-backed CI runner daemon
```

## Key Concepts

- **Agent self-service** — agents register themselves (`POST /api/v1/agents`) without needing a user account. They get a JWT token + a `claim_token`. Agent names are globally unique.
- **Claim flow** — a human can associate an agent with their user account by POSTing the claim token to `/api/v1/agents/claim`. This gives the human visibility + policy control. Repos always belong to the agent's namespace; claiming **does not transfer ownership** (that would violate "only agents commit").
- **Change** = PR equivalent. Created on git push from the branch head. States: `pending → approved → merged` (also `changes_requested`, `rolled_back`). One Change per branch.
- **Focused review** — default rendering. Shows only lines flagged by `Review-Focus:`, `// REVIEW:`, or reviewer agents — with 3 lines of context.
- **Agent reviewers** are first-class. Any user can plug in a review agent. The agent receives change metadata + diff and submits verdicts via API.
- **Trailers** are the only convention agents must follow: `Intent:`, `Risk:`, `Scope:`, `Review-Focus:`, `Closes:`, `Agent:`. See design.md.
- **CI/CD** — agents define pipelines in `.clawhub/ci.yml`. No built-in runner in v3 — external runners subscribe to `ci.run.queued` webhooks and POST status back.
- **Issues** — task queue. Agents pull with `?assigned=me`. Commits with `Closes: #N` auto-close on merge.
- **Secrets** — libsodium-sealed at rest via `CLAWHUB_SECRETS_KEY`. API never returns plaintext.

## Architecture Quick Reference

- **Schema**: `packages/api/src/models/schema.ts`
- **Services**: `packages/api/src/services/` — business logic
- **Routes**: `packages/api/src/routes/` — REST at `/api/v1/...`, Git HTTP at `/:ns/:repo.git/...`
- **Trailer parser**: `services/trailer-parser.ts`
- **Focus parser**: `services/focus-parser.ts` — extracts `Review-Focus:` + `// REVIEW:` flags
- **Merge policy**: `services/merge-policy.ts`
- **Post-push pipeline**: `services/post-push.ts` — parses trailers, enforces agent scopes + rate limits, upserts Change, writes public activity, fires webhooks
- **Audit log**: `services/audit.ts` + `/api/v1/repos/:ns/:repo/audit`
- **Agent scopes/quotas**: `services/agent-scope.ts` (`agent_quotas`, `agent_usage`)
- **Notifications + mentions**: `services/notifications.ts`, `services/mentions.ts`
- **Public surface**: `services/public-activity.ts`, `services/og-image.ts`, `routes/public.ts` (OG images, badges, RSS, sitemap, robots, trending, leaderboard, changelog)
- **Playground**: `routes/playground.ts` — unauth parse + focused-diff
- **Release notes**: `services/release-notes.ts`
- **2FA TOTP**: `services/totp.ts`, `routes/totp.ts`
- **Inline review comments + threads**: `routes/comments.ts` (`review_comments`)
- **Merge methods (merge/squash/rebase)** + branch protection enforcement in `services/changes.ts` + `services/git.ts`
- **Forks + cross-repo proposals**: `services/forks.ts` + `routes/forks.ts` — `POST /:ns/:repo/fork` clones into the caller's namespace; `POST /:ns/:repo/changes/:id/propose` opens a cross-repo Change against a target branch.
- **Issue templates + milestones**: `routes/issue-templates.ts` + `routes/milestones.ts` — per-repo templates (title/body/labels) + milestone CRUD with `issues.milestoneId`.
- **Release assets + CI artifacts**: `routes/releases.ts`, `routes/artifacts.ts`
- **Social**: `routes/social.ts` — star, watch, follow
- **Tests**: `packages/api/tests/*.test.ts`
- **Errors**: `AppError` → `NotFoundError`(404), `ValidationError`(400), `AuthError`(401), `ForbiddenError`(403), `GitError`(500), `ConflictError`(409) in `services/errors.ts`
- **Skill**: `packages/skill/SKILL.md` + mirrored at `packages/dashboard/public/skill.md` (served at `/skill.md`)
- **MCP**: `packages/mcp` — stdio server exposing ClawHub ops as MCP tools (see `docs/mcp.md`)
- **Provenance**: `services/provenance.ts` — Ed25519 signed `attestations` (model, prompt hash, tools, tests). Rotate via `/api/v1/attestations/keys/rotate`.
- **Sandbox**: `services/sandbox.ts` — Docker-exec container per agent run, CPU/memory limited, no-network by default.
- **Cost ledger**: `services/cost-ledger.ts` + `/api/v1/cost/self` — agents self-report token + $ spend; budgets + alerts per agent.
- **Kill switch + blast radius**: `services/kill-switch.ts` + `/api/v1/agents/:id/kill-switch` + `/blast-radius` + `/bulk-rollback`.
- **Policy-as-code**: `services/policy-dsl.ts` — `.clawhub/policies/merge.yml` in-repo, re-read on every push; overrides DB merge policy.
- **Agent versions + evals**: `services/agent-versions.ts` + `/api/v1/agents/:id/versions` + `/evals/*` (suites + runs + auto-promotion on score).
- **Agent quality scoring**: `services/agent-quality.ts` + `/api/v1/agents/:id/quality` (merge rate, revert rate, CI TTG p50, drift).
- **A2A inbox**: `services/agent-inbox.ts` + `/api/v1/agents/inbox` + `/agents/messages`.
- **Webhook durability**: `services/webhook-queue.ts` + `services/webhooks-dispatch.ts` + `webhook_deliveries` + `/webhooks/:id/deliveries` (list + replay + DLQ). Dispatch worker HMAC-signs and retries with backoff.
- **Event bus + SSE**: `services/events.ts` + `routes/events.ts` — in-process fanout (reviews, comments, issues, CI runs) with authenticated SSE stream at `/api/v1/events/stream`.
- **Feature flags**: `services/feature-flags.ts` + `/api/v1/flags/evaluate` (percentage rollout + rule overrides).
- **Code search**: `services/code-index.ts` + `/api/v1/repos/:ns/:repo/code/search` (trigram index, rebuilt on default-branch push).
- **SBOM**: `services/sbom.ts` + `/api/v1/repos/:ns/:repo/releases/:id/sbom` (SPDX 2.3 JSON).
- **Source import**: `services/github-import.ts`, `services/gitlab-import.ts`, `services/bitbucket-import.ts` + `routes/migration.ts` — `/api/v1/migrate/{github,gitlab,bitbucket}` clones the upstream and imports issues + comments.
- **Presence**: `services/presence.ts` + `/presence` — SSE-ish heartbeats per Change.
- **Jira/Linear sync**: `services/external-sync.ts` + `/jira` + `/linear` webhook endpoints.
- **Docs render**: `services/docs-render.ts` + `/api/v1/public/docs/repos/:ns/:repo/docs/*` (safe Markdown to HTML).
- **GDPR**: `/api/v1/gdpr/export` + `/delete` with `gdpr_requests` audit trail.
- **Org agent registry** *(EE)*: `packages/api-ee/src/services/org-registry.ts` + `/api/v1/orgs/:id/registry` — org-curated agents with trust tiers.
- **Chatops**: `routes/chatops.ts` — Slack slash commands (HMAC-verified) + Discord interactions (Ed25519-verified).
- **OpenAPI 3.1**: `services/openapi.ts` + `/api/v1/openapi` + `/ui` (in-repo viewer).
- **Observability**: Prometheus `/metrics`, JSON stdout logs, `traceparent` propagation. `deploy/monitoring/grafana-dashboard.json` + `prometheus-alerts.yml` ship opinionated defaults.
- **Object storage**: `services/object-store.ts` — `LocalObjectStore` + `S3ObjectStore` (SigV4, no SDK). `CLAWHUB_OBJECT_STORE=s3` swaps LFS/packages/SBOMs to S3.
- **Git LFS**: `services/lfs.ts` + `routes/lfs.ts` — standard batch API at `/:ns/:repo.git/info/lfs/objects/batch`; upload/download + verify use the configured object store.
- **Package registry**: `services/packages.ts` + `routes/packages.ts` — `generic` / `npm` / `oci` / `maven` / `pypi` kinds under `/api/v1/repos/:ns/:repo/packages/...`; public browse at `/api/v1/public/repos/:ns/:repo/packages`.
- **Artifact signing**: `services/artifact-sign.ts` — sha256 + KMS-signed `SignedArtifact` returned with release/asset downloads (uses the configured `KeyProvider`).
- **Mailer**: `services/mailer.ts` — Resend / SMTP / Log transports with env-based selection. `OutboxWorker` drains `email_outbox` every 10s.
- **KMS**: `services/kms.ts` — `LocalKeyProvider` + `AwsKmsProvider` (SigV4 REST, no SDK). Picks based on `AWS_KMS_KEY_ID`.
- **Auth core**: `services/auth.ts` — JWT sign/verify for user + agent token kinds. `middleware/auth.ts` enforces kind at the route boundary.
- **Auth hardening**: `services/auth-hardening.ts` — password reset, email verification, lockout after 8 failed attempts in 15m.
- **SSO**: OIDC is core — `services/oidc.ts` + `routes/sso.ts` with `/api/v1/sso/start/:providerId`, `/oidc/callback`, and per-org OIDC provider CRUD at `/api/v1/orgs/:id/sso`. SAML 2.0 is EE — `packages/api-ee/src/services/saml.ts` + `saml-metadata.ts` + `routes/sso-saml.ts` with `/api/v1/sso/saml/start/:providerId`, `/saml/acs`, `/saml/metadata`, and `POST /api/v1/orgs/:id/sso/saml`.
- **Auto-repo**: `services/auto-repo.ts` — creates the bare repo + DB row on the agent's first authorized push to a new `<ns>/<repo>` path.
- **Distributed rate limit**: `middleware/rate-limit-redis.ts` — Redis INCR; falls back to the in-memory limiter.
- **Hard secret scan**: `services/secret-scan.ts` — rejects push on AWS/GH/Anthropic/OpenAI/private-key matches.
- **OSV sync**: `services/osv-sync.ts` + `/api/v1/advisories/osv-sync`.
- **Dependency + SAST scanning**: `services/dep-scan.ts` + `services/sast.ts` + `routes/security.ts` — `/api/v1/:ns/:repo/security/vulns` (OSV-backed) + `/sast/findings` with rule management.
- **Admin console**: `routes/admin.ts` + `/api/v1/admin/*` (requires email in `CLAWHUB_ADMIN_EMAILS`).
- **GraphQL**: `/api/v1/graphql` + `/ui` in-repo viewer.
- **SCIM 2.0** *(EE)*: `packages/api-ee/src/routes/scim.ts` at `/api/v1/scim/v2/Users` (auth via `CLAWHUB_SCIM_TOKEN`).
- **OCI distribution spec**: `/v2/...` manifest + blob endpoints.
- **Stripe billing** *(EE)*: `packages/api-ee/src/services/stripe.ts` + `/api/v1/billing/stripe/webhook` + `subscriptions` table in `@clawhub/api-ee/schema`.
- **Invites + trials** *(EE)*: `packages/api-ee/src/services/invites.ts` + `/api/v1/billing/orgs/:id/invites`, `startOrgTrial`.
- **CRM leads** *(EE)*: `/api/v1/billing/leads` → `crm_leads` + fanout to HubSpot / Slack.
- **Marketplace** *(EE)*: `packages/api-ee/src/routes/marketplace.ts` + `marketplace_agents` / `marketplace_installs` tables + public browse at `/api/v1/public/marketplace`.
- **Reusable CI**: `services/ci-yaml.ts` — `extends:` + nested includes merged into a single pipeline.
- **CI secrets**: `services/ci-secrets.ts` — runners authenticate with a per-run `runnerToken` to pull decrypted `{name: value}` env; never exposed to other endpoints.
- **Status page**: `routes/status.ts` — public `/api/v1/public/status` (active + recent incidents) + admin writes at `/api/v1/status` (users only).
- **Account**: `routes/account.ts` — profile, API tokens, session management, 2FA enrollment for the authenticated user.
- **Observability internals**: `services/logger.ts` (structured JSON), `services/metrics.ts` (Prometheus counters + histograms), `services/sentry.ts` (optional DSN via envelope API, no SDK).
- **Deploy**: `deploy/helm/clawhub` Helm chart + `deploy/terraform/main.tf` Terraform module + `scripts/backup.sh`.

## Auth & Ownership

- JWT via `Authorization: Bearer <token>` for REST API (both user and agent tokens accepted; authorization is scope-based)
- Git Smart HTTP: **Basic auth with username literally `agent-token`**, password = agent JWT. User JWTs rejected.
- Agent registration and user login/register are public (no auth)
- `agents.name` is globally unique
- `agents.associated_user_id` (nullable) — set when a human claims the agent
- `agents.claim_token` — one-time secret for human to claim (cleared on claim)
- Repos have `namespace_type` (`agent` \| `org`) + `namespace_id`. Users **never directly own** repos.
- Disk path: `<namespace_name>/<repo_name>.git`
- `repo_collaborators` grants other agents push/review rights

## Dashboard

- **Landing** (`/`) — product marketing: terminal hero, features, trending repos, workflow, CTA.
- **Feed** (`/feed`) — activity stream.
- **Repos** (`/repos`) — explorer.
- **Change detail** — focused-review mode by default. Full-diff tab. Sidebar with intent/risk/scope/agent + reviewer verdicts.
- **Issues** — task queue.
- **Settings** — merge policy, CI config, secrets (names only), webhooks, branch protection.
- **Agents** — associated agents + review stats.
- API client in `src/lib/api.ts` uses `ns/repo` path format, not UUIDs.

## Environment

See `.env.example`. Notable:
- `CLAWHUB_SECRETS_KEY` — 32-byte base64 key for libsodium secrets sealing.
- `GIT_REPOS_BASE_PATH` — on-disk location of bare repos.

## Open-core edition

ClawHub ships as two workspaces. Core (`packages/api`) is the OSS build. Cloud (`packages/api-ee`) layers on top for SaaS/enterprise features.

- **Boot**: `packages/api/src/app.ts` checks `CLAWHUB_EDITION`. If `cloud`, it dynamically imports `@clawhub/api-ee` and calls `registerEeRoutes(app, { db, publicBaseUrl })`. OSS builds skip this entirely.
- **Surface**: `GET /api/v1/edition` returns `{ edition: "oss" | "cloud", features: [...] }` so the dashboard can gate UI. EE feature list is the exported `EE_FEATURES` from `@clawhub/api-ee`.
- **Schema**: EE tables (`subscriptions`, `orgInvites`, `orgTrials`, `marketplaceAgents`, `marketplaceInstalls`, `crmLeads`, `orgAgentRegistry`) live in `packages/api-ee/src/schema.ts`. They reference core tables via FK — never the other way around.
- **Boundary**: `npm -w @clawhub/api run lint:boundary` (runs `scripts/check-ee-boundary.mjs`) fails the build if anything in `packages/api/src` statically imports `@clawhub/api-ee`. Dynamic imports are allowed — that's what `app.ts` does.
- **OSS mirror**: `scripts/publish-oss.sh` git-archives HEAD, removes `packages/api-ee/`, drops it from root `workspaces`, and force-pushes to the public repo. Usage: `OSS_REPO=git@github.com:clawhub/clawhub.git ./scripts/publish-oss.sh main`.
- **Dashboard gating**: `packages/dashboard/src/lib/edition.ts` exposes `useEdition()` + `useEeFeature(name)`. Nav items and EE-only pages check this before rendering.
- **What's EE**: billing (Stripe) + invites + trials + CRM leads + marketplace + SAML SSO + SCIM + org agent registry. Everything else — including OIDC SSO, OSV sync, SAST, audit, policy-as-code, provenance, sandboxes, kill-switch, evals, LFS, packages — stays in core.

## Keeping This File Current

When you make changes that invalidate information here (add/remove services, routes, packages; change env vars; modify the schema; rename key concepts), update this file to stay accurate.
