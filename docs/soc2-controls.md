# SOC2 controls mapping for ClawHub

This document maps SOC2 (Type II) common criteria to the built-in mechanisms ClawHub ships with. It is not a certification; it's an evidence-gathering guide for your auditor.

## CC6 — Logical & physical access

| Control | ClawHub mechanism | Evidence |
| --- | --- | --- |
| CC6.1 User provisioning | `users` + `org_members`, claimable agents with `claim_token`. | `/api/v1/orgs/:id/members`, `/api/v1/agents` registration |
| CC6.1 MFA | TOTP (`/api/v1/totp/*`, RFC 6238) | `users.totp_enabled = true` on sensitive accounts |
| CC6.1 SSO | OIDC (PKCE) + SAML 2.0 (signature-verified) | Org-scoped providers in `sso_providers`; successful logins recorded to `audit_events` |
| CC6.6 Key rotation | `signing_keys.rotated_at`; POST `/api/v1/attestations/keys/rotate` | Audit log |
| CC6.7 Encryption at rest | `secrets` sealed with libsodium (`CLAWHUB_SECRETS_KEY`) | `secrets.ciphertext` is base64 sealed-box |
| CC6.8 Least privilege | Agent scopes (path allow/deny, risk ceiling, LOC cap, rate limits) | `agent_quotas` + enforcement in `post-push` + reviews |

## CC7 — System operations

| Control | ClawHub mechanism | Evidence |
| --- | --- | --- |
| CC7.2 Monitoring | Prometheus `/metrics`, JSON logs, `traceparent` propagation | `/metrics` scrape + logs |
| CC7.3 Incident response | Kill switch + blast radius report + bulk rollback | `/api/v1/agents/:id/kill-switch`, `/blast-radius`, `/bulk-rollback` |
| CC7.4 Vulnerability management | Dependency scan + SAST on each push | `vuln_findings`, `sast_findings` |

## CC8 — Change management

| Control | ClawHub mechanism | Evidence |
| --- | --- | --- |
| CC8.1 Change approval | Merge policies (human / risk / CI) | `repositories.merge_policy`, `changes.status` |
| CC8.1 Change provenance | Signed attestations linking commit → agent + model + prompt hash + tools | `attestations` table, Ed25519 signatures |
| CC8.1 Rollback capability | Revert-commit based rollback + full audit | `changes.status = rolled_back` |
| CC8.1 Segregation of duties | Enforced at the **merge gate**: a human owns every merge above low risk, and an author (agent or human) cannot serve as the independent human approver of their own change — sensitive paths + high risk require a human who reviewed the code. | `services/merge-policy.ts` gate + `reviews.basis` (`behavior`/`code`); `changes.openedByAgentId`/`openedByUserId` records the author so self-approval is distinguishable |

## CC9 — Risk mitigation

| Control | ClawHub mechanism | Evidence |
| --- | --- | --- |
| CC9.2 Vendor mgmt | Agent registry per org; trust tiers | `org_agent_registry` |
| CC9.2 Data subject rights | GDPR export + deletion | `/api/v1/gdpr/*` |
| CC9.2 Data retention | Audit log, cost ledger retained indefinitely; `gdpr_requests` for deletes | Review retention windows per control |

## Audit evidence

- Every auth / change / merge / review / secret-read / agent-scope-violation writes to `audit_events`.
- Webhook deliveries are durable (`webhook_deliveries`) with retries + dead-letter status.
- Metrics (Prometheus) retain counters for requests, changes merged, reviews submitted, CI runs.

## Gaps you must close for certification

- Formal policies + procedures docs (we ship mechanism; auditors want you to write the policy).
- Annual risk assessment + pen-test attestation.
- Business continuity + DR test evidence (run the runbook in `docs/dr-runbook.md` and keep the logs).
- Vendor review documentation for any third party (e.g. email sender, IdP, storage).
