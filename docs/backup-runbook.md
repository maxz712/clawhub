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

## Built-in repo backups (`ch backup`)

Off-host git backups, complementary to the repo tarball above — this covers git
objects + refs only, **not** Postgres. Run the worker with `CLAWHUB_OBJECT_STORE=s3`
plus `S3_BUCKET` + `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`:

```bash
npm -w @clawhub/api run start:backup     # dev:backup for a dev checkout
```

It sweeps every `CLAWHUB_BACKUP_INTERVAL_MS` (default 1h). Each backup is three
objects under `clawhub/backups/<repoId>/<ts>/`:

| Object | Contents |
|---|---|
| `objects.pack` | A real git packfile. Incrementals carry only the objects added since the parent backup (`haves` = the parent's ref shas); a FULL pack is taken with no usable parent and every `CLAWHUB_BACKUP_FULL_EVERY` (default 10) backups. |
| `refs.json` | `refs/heads/*` + `refs/clawhub/changes/*` at the snapshot. |
| `manifest.json` | `version: 2`, `packs[]` (with sha256), `refShas`, `parentManifestKey`, `refLogTip`, `full`. |

A restore walks the manifest chain back to the last full pack, applies every
pack oldest-first, then writes the refs. It is all-or-nothing: a missing pack, a
sha256 mismatch or a single ref that will not write throws, increments
`clawhub_repo_restore_total{result="failed"}`, and exits the CLI non-zero.

> **Backups taken before the fix for #140 are refs-only and are NOT restorable** —
> they contain no git objects. A restore of one is refused with `not_restorable`
> rather than silently producing an empty repo. Take a fresh backup
> (`ch backup run <repoId>`) and confirm it reports `objects: 1 pack(s)`.

### Verify a restore

**Never verify against production.** `ch backup restore` writes into the repo's
real path (`$GIT_REPOS_BASE_PATH/<ns>/<repo>.git`) and moves its refs to the
backed-up shas. Verify on a staging instance pointed at a scratch
`GIT_REPOS_BASE_PATH` and a restored copy of the Postgres dump:

```bash
ch backup list <repoId>
ch backup restore <repoId> <backupId> local     # "local" = the unsharded disk tier
#   ✓ restored <repoId> to local
#     refs: 42/42  packs applied: 3      <- must be N/N, not N/M

cd "$GIT_REPOS_BASE_PATH/<ns>/<repo>.git"
git fsck --full                                  # no missing/dangling objects
git for-each-ref --format='%(objectname) %(refname)' | sort > /tmp/restored-refs
```

Then diff `/tmp/restored-refs` against the manifest's `refShas` (or the
`refs.json` sibling object) — every sha in the manifest must be present and
point at the same ref. Do this monthly, alongside the Postgres restore drill.

## On-disk integrity

Set `fsync=on` + `synchronous_commit=on` on the primary. Enable WAL archiving + replication:

```
archive_mode = on
archive_command = 'test ! -f /wal/%f && cp %p /wal/%f'
max_wal_senders = 3
```
