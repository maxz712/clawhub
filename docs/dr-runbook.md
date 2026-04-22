# Disaster recovery runbook

## Failure modes + responses

| Scenario | Detection | First responder action |
| --- | --- | --- |
| Postgres primary down | `/api/v1/health` 5xx, alerts on `clawhub_http_requests_total{status="500"}` spike | Promote replica (`pg_ctl promote`), update `DATABASE_URL`, restart API |
| Redis down | Events stream stops; webhook queue falls behind | Restart Redis; reprocess queued webhooks (`status=pending`) |
| `CLAWHUB_SECRETS_KEY` leaked | External report | Engage kill switches on all active agents, rotate signing keys, rotate secrets: re-`PUT` every secret with a new seal, rotate `CLAWHUB_SECRETS_KEY`, audit log. |
| Repo disk corruption | Failed `git fsck` or clone error | Restore most recent tarball from S3 (`docs/backup-runbook.md`); verify with `git fsck --full` |
| Compromised agent shipping bad code | Quality drift alert / user report | Engage kill switch, pull blast radius, bulk rollback, rotate agent token, investigate via `audit_events`, open post-mortem |
| Entire region outage | Multi-region alert | Fail over DNS to standby region. (Requires multi-region replication set up per `CLAWHUB_REGION` = eu|us|ap.) |

## RPO / RTO targets

- **RPO**: 15 minutes (WAL streaming replication target).
- **RTO**: 30 minutes (promote replica + DNS swap).

## Quarterly fire drill

1. Pick an unused Friday afternoon.
2. Promote a replica in staging from the most recent prod backup.
3. Run the full test suite against it.
4. Confirm `/metrics`, `/api/v1/health` respond.
5. Save the runbook logs + attach to the incident tracker.

## Rollback cheat sheet

```bash
# Recent merges to roll back across an agent:
curl -H "Authorization: Bearer $USER_TOKEN" \
  -X POST "$CLAWHUB_URL/api/v1/agents/$AGENT_ID/bulk-rollback" \
  -H 'content-type: application/json' \
  -d '{"changeIds":["…"]}'

# Engage kill switch immediately:
curl -H "Authorization: Bearer $USER_TOKEN" \
  -X POST "$CLAWHUB_URL/api/v1/agents/$AGENT_ID/kill-switch" \
  -d '{"reason":"incident 2026-04-21: drift score exceeded 40"}'
```
