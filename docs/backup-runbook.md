# Backup runbook

## What must be backed up

1. **Postgres** — all business state (repos, changes, issues, attestations, cost ledger, audit).
2. **Git repositories on disk** — `GIT_REPOS_BASE_PATH` (default `./data/repos`). Contains bare repos + LFS objects + package files + SBOMs.
3. **`CLAWHUB_SECRETS_KEY`** — 32-byte base64 key used to unseal repo secrets. Without it, secrets are unreadable.
4. **Active signing key** — stored in the `signing_keys` table; rotate regularly and keep the old keys to verify historical attestations.

## Daily automated backup

```bash
#!/bin/bash
set -euo pipefail

DATE=$(date +%Y%m%d)
DEST="${BACKUP_BUCKET:-s3://clawhub-backups}"

# 1. Postgres logical dump (point-in-time + gzip).
pg_dump --format=custom --compress=9 "$DATABASE_URL" > "/tmp/clawhub-${DATE}.dump"
aws s3 cp "/tmp/clawhub-${DATE}.dump" "${DEST}/postgres/"

# 2. Git repo tree (rsync with checksum).
tar -czf "/tmp/repos-${DATE}.tar.gz" -C "${GIT_REPOS_BASE_PATH}" .
aws s3 cp "/tmp/repos-${DATE}.tar.gz" "${DEST}/repos/"

# 3. Config (encrypted with age or sops).
{ printf 'CLAWHUB_SECRETS_KEY=%s\n' "$CLAWHUB_SECRETS_KEY"; } | age -r "${BACKUP_PUBKEY}" > "/tmp/secrets-${DATE}.age"
aws s3 cp "/tmp/secrets-${DATE}.age" "${DEST}/secrets/"

rm -f /tmp/clawhub-*.dump /tmp/repos-*.tar.gz /tmp/secrets-*.age
```

## Retention

- Postgres dumps: 90 days. Weekly consolidation for the last 2 years.
- Repo tarballs: 30 days. Monthly for the last 2 years.
- Secrets envelope: forever. (Without it, nothing can be decrypted.)

## Verify

Every Monday: restore the previous Sunday's dump into a staging DB + run the SBOM-of-SBOMs smoke test:
```bash
pg_restore --clean --if-exists --dbname="$STAGING_DB_URL" "/tmp/clawhub-$(date -d 'last sunday' +%Y%m%d).dump"
psql "$STAGING_DB_URL" -c "select count(*) from changes;"  # expect > 0
```

## On-disk integrity

Set `fsync=on` + `synchronous_commit=on` on the primary. Enable WAL archiving + replication:

```
archive_mode = on
archive_command = 'test ! -f /wal/%f && cp %p /wal/%f'
max_wal_senders = 3
```
