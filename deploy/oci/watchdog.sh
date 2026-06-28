#!/usr/bin/env bash
# $0-spend watchdog — REACTIVE layer of the OCI cost guard (the preventive
# compartment quota + the detective budget/ONS-email alert sit off-host and are
# the primary protection; this is belt-and-suspenders). Runs on the OCI host
# (clawhub-prod) via instance principals (no API key on disk) — it was relocated
# here off the (now fully decommissioned) debian-server during the 2026-06 OCI
# migration.
#
# Each tick: (1) read tenancy month-to-date cost; if > $0, publish to the ONS
# alert topic. (2) SOFTSTOP any RUNNING instance NOT in the allowlist, across
# all compartments — EXCEPT it is fail-safe: if the allowlist contains no
# `ocid1.instance.` line it only alerts (never stops), so a freshly-launched
# instance can't be killed before it's whitelisted.
#
# Env:
#   TENANCY_OCID     tenancy OCID (required)
#   ONS_TOPIC_ID     ONS topic OCID for alerts (required)
#   ALLOWLIST_FILE   path to allowlist (one OCID per line; default ./allowlist.txt)
#   OCI             oci CLI invocation (default: "oci --auth instance_principal")
set -euo pipefail

: "${TENANCY_OCID:?set TENANCY_OCID}"
: "${ONS_TOPIC_ID:?set ONS_TOPIC_ID}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$(dirname "$0")/allowlist.txt}"
OCI="${OCI:-oci --auth instance_principal}"

alert() { $OCI ons message publish --topic-id "$ONS_TOPIC_ID" --title "clawhub spend alert" --body "$1" >/dev/null 2>&1 || true; }

# (1) Month-to-date cost. usage-api wants a midnight-aligned [start,end).
start="$(date -u +%Y-%m-01T00:00:00Z)"
end="$(date -u +%Y-%m-%dT00:00:00Z)"
cost="$($OCI usage-api usage-summary request-summarized-usages \
  --tenant-id "$TENANCY_OCID" --granularity MONTHLY --query-type COST \
  --time-usage-started "$start" --time-usage-ended "$end" \
  --group-by '["currency"]' 2>/dev/null \
  | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("0"); sys.exit()
print(sum(float(i.get("computed-amount") or 0) for i in d.get("data",{}).get("items",[])))' 2>/dev/null || echo 0)"

echo "$(date -u +%FT%TZ) mtd_cost=$cost"
awk "BEGIN{exit !($cost > 0)}" && alert "Tenancy month-to-date cost is \$$cost (expected \$0). Investigate immediately."

# (2) Auto-stop non-allowlisted running instances (fail-safe: only if the
# allowlist names at least one instance OCID).
if grep -q '^ocid1.instance.' "$ALLOWLIST_FILE" 2>/dev/null; then
  for comp in $($OCI iam compartment list --compartment-id "$TENANCY_OCID" --compartment-id-in-subtree true --all \
      --query 'data[?"lifecycle-state"==`ACTIVE`].id' --raw-output 2>/dev/null | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)))' 2>/dev/null) "$TENANCY_OCID"; do
    $OCI compute instance list --compartment-id "$comp" --lifecycle-state RUNNING --all \
      --query 'data[].id' --raw-output 2>/dev/null \
      | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)))' 2>/dev/null \
      | while read -r inst; do
          [ -z "$inst" ] && continue
          if ! grep -qF "$inst" "$ALLOWLIST_FILE"; then
            alert "SOFTSTOP non-allowlisted instance $inst"
            $OCI compute instance action --instance-id "$inst" --action SOFTSTOP --force >/dev/null 2>&1 || true
          fi
        done
  done
else
  echo "allowlist has no instance OCID — alert-only (fail-safe), not stopping anything"
fi
