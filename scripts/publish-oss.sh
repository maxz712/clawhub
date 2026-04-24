#!/usr/bin/env bash
# Mirror the current tree to the public OSS repo, stripping the cloud edition.
#
# Usage: OSS_REPO=https://github.com/clawhub/clawhub.git ./scripts/publish-oss.sh [branch]
#
# What it does:
#   1. git-archives the current HEAD into a scratch dir
#   2. removes packages/api-ee/ entirely
#   3. drops "packages/api-ee" from root package.json workspaces
#   4. force-pushes the result to $OSS_REPO on the given branch (default: main)
#
# The OSS build then has zero trace of the cloud edition — imports, schema, tests all gone.

set -euo pipefail

OSS_REPO="${OSS_REPO:-}"
BRANCH="${1:-main}"

if [[ -z "$OSS_REPO" ]]; then
  echo "OSS_REPO env var required (e.g. OSS_REPO=https://github.com/clawhub/clawhub.git)" >&2
  exit 1
fi

if ! command -v git >/dev/null; then
  echo "git is required" >&2; exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

sha="$(git rev-parse --short HEAD)"
scratch="$(mktemp -d -t clawhub-oss-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT

echo "[oss] sha=$sha scratch=$scratch"

# 1. Export the current HEAD (tracked files only — no local junk).
git archive --format=tar HEAD | tar -x -C "$scratch"

# 2. Strip the cloud edition completely.
rm -rf "$scratch/packages/api-ee"

# 3. Remove api-ee from the root workspaces list.
node - <<EOF
const fs = require("node:fs");
const path = "$scratch/package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.workspaces = (pkg.workspaces || []).filter(w => w !== "packages/api-ee");
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
EOF

# 4. Commit + force-push the stripped tree.
cd "$scratch"
git init -q -b "$BRANCH"
git add -A
git -c user.name="clawhub-oss-bot" -c user.email="oss@clawhub.dev" \
  commit -q -m "Mirror from private @ $sha" --no-verify
git remote add origin "$OSS_REPO"
git push -f origin "$BRANCH"

echo "[oss] pushed $BRANCH to $OSS_REPO (source sha $sha)"
