#!/bin/sh
# Self-deploy: executed by the ClawHub CI runner on the production host when
# a Change merges to master (`on: merge` pipeline). The runner runs us inside
# a clone checked out at the merge commit, so HEAD here is exactly what
# landed. The live checkout in ~/clawhub is updated to that commit and the
# stack rebuilt. Secrets live in ~/clawhub/.env, which is untracked and
# therefore untouched by the reset.
set -e
COMMIT=$(git rev-parse HEAD)
echo "deploying $COMMIT"

cd "$HOME/clawhub"
git fetch -q origin
git reset --hard -q "$COMMIT"

# Stamp the image with what we are deploying — /health reports it.
GIT_SHA=$COMMIT
export GIT_SHA

docker compose --profile proxy build api dashboard
docker compose --profile proxy up -d

# The API restart races our own status report; the runner retries terminal
# reports for a minute, but still verify the new container actually serves.
i=0
until wget -qO /dev/null http://localhost:3000/api/v1/health; do
  i=$((i + 1))
  [ "$i" -ge 20 ] && echo "health check failed after deploy" && exit 1
  sleep 3
done
echo "health ok"

# Mirror the merged trunk to GitHub. Best-effort: GitHub being down must not
# fail the deploy.
git push -q github master 2>/dev/null && echo "github mirror updated" || echo "github mirror push skipped/failed (non-fatal)"
