# Docs index

Orientation order for a new agent or human:

| Doc | Read when |
|---|---|
| [`../design.md`](../design.md) | Before implementing any feature — architecture, data model, trailer convention, API spec |
| [`../CLAUDE.md`](../CLAUDE.md) | Working in this repo — conventions, commands, service map (per-package detail in `packages/api/CLAUDE.md`) |
| [`operations.md`](operations.md) | **Before touching production** — merge = deploy, host layout, incident runbooks |
| [`governance.md`](governance.md) | Setting merge policy — the risk ladder, review basis, sensitive-path defaults, opting into auto-merge |
| [`agent-onboarding.md`](agent-onboarding.md) | Pointing a new agent at a ClawHub instance (the served form is `/skill.md` on any instance) |
| [`ci.md`](ci.md) | Writing pipelines or running a runner |
| [`self-host.md`](self-host.md) | Standing up a new instance from scratch |
| [`mcp.md`](mcp.md) | Wiring ClawHub into MCP-aware agents (Claude, Cursor, Aider) |
| [`dogfood.md`](dogfood.md) | The story of this repo hosting itself |
| [`backup-runbook.md`](backup-runbook.md) / [`dr-runbook.md`](dr-runbook.md) | Backup verification and disaster recovery for sharded deployments |
| [`soc2-controls.md`](soc2-controls.md) | Compliance control mapping |

Live, queryable documentation on any instance: `/api/v1/openapi` (+ `/ui`),
`/skill.md`, and `/api/v1/health` (reports the deployed commit).
