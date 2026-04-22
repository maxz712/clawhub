#!/usr/bin/env bash
# ClawHub automated backup. Run from cron / systemd timer / k8s CronJob.
# Env vars required:
#   DATABASE_URL            postgres connection string
#   GIT_REPOS_BASE_PATH     on-disk bare-repo root
#   CLAWHUB_SECRETS_KEY     32-byte base64 (libsodium seal key)
# Optional:
#   BACKUP_BUCKET           s3://.../ (enables S3 upload)
#   BACKUP_AGE_RECIPIENT    age public key to encrypt secrets envelope
#   BACKUP_RETENTION_DAYS   default 90
set -euo pipefail

DATE=$(date -u +%Y%m%dT%H%M%SZ)
RETENTION="${BACKUP_RETENTION_DAYS:-90}"
WORKDIR=$(mktemp -d -t clawhub-backup-XXXXXX)
trap 'rm -rf "$WORKDIR"' EXIT

echo "[backup] starting ($DATE)"

# 1. Postgres.
pg_dump --format=custom --compress=9 "$DATABASE_URL" > "$WORKDIR/clawhub-${DATE}.dump"
echo "[backup] db dumped: $(du -h "$WORKDIR/clawhub-${DATE}.dump" | cut -f1)"

# 2. Git repos (+ LFS + packages + SBOMs — all live under GIT_REPOS_BASE_PATH).
if [[ -n "${GIT_REPOS_BASE_PATH:-}" && -d "$GIT_REPOS_BASE_PATH" ]]; then
  tar -C "$GIT_REPOS_BASE_PATH" -czf "$WORKDIR/repos-${DATE}.tar.gz" .
  echo "[backup] repos archived: $(du -h "$WORKDIR/repos-${DATE}.tar.gz" | cut -f1)"
fi

# 3. Secrets envelope (encrypted to an age recipient — plaintext is never written to disk).
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && command -v age >/dev/null 2>&1; then
  {
    printf 'CLAWHUB_SECRETS_KEY=%s\n' "$CLAWHUB_SECRETS_KEY"
    printf 'JWT_SECRET=%s\n' "${JWT_SECRET:-unset}"
  } | age -r "$BACKUP_AGE_RECIPIENT" > "$WORKDIR/secrets-${DATE}.age"
  echo "[backup] secrets sealed"
fi

# 4. Upload.
if [[ -n "${BACKUP_BUCKET:-}" ]]; then
  aws s3 cp "$WORKDIR/" "$BACKUP_BUCKET/${DATE}/" --recursive --sse AES256 --storage-class STANDARD_IA
  echo "[backup] uploaded to $BACKUP_BUCKET/${DATE}/"
  # Cleanup old S3 objects past retention. (Requires lifecycle policy for correctness;
  # this is a safety net.)
  cutoff=$(date -u -d "${RETENTION} days ago" +%Y%m%d || date -u -v-"${RETENTION}d" +%Y%m%d)
  aws s3 ls "$BACKUP_BUCKET/" | awk '{print $NF}' | while read prefix; do
    d=${prefix%%T*}
    if [[ "$d" < "$cutoff" && -n "$d" ]]; then
      aws s3 rm "$BACKUP_BUCKET/$prefix" --recursive || true
    fi
  done
fi

echo "[backup] done"
