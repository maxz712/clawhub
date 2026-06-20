#!/usr/bin/env bash
# Narrow the OCI Security List so the origin is reachable ONLY through
# Cloudflare on 80/443 (no Host-header bypass of the WAF/rate-limit) and SSH
# only from admin IPs. Idempotent + safe to re-run (e.g. weekly, to pick up
# Cloudflare's published-range changes). Run from a host with the OCI CLI
# configured (this is what was applied live on 2026-06-20).
#
# Env:
#   SECURITY_LIST_ID   the subnet's security list OCID (required)
#   ADMIN_CIDRS        space-separated CIDRs allowed to SSH (required),
#                      e.g. "72.142.18.42/32 97.113.244.228/32"
#
# Rollback (re-open everything): re-run with WIDE_OPEN=1, or apply 3 rules
# from 0.0.0.0/0 for 22/80/443 via `oci network security-list update`.
set -euo pipefail

: "${SECURITY_LIST_ID:?set SECURITY_LIST_ID to the subnet security-list OCID}"
: "${ADMIN_CIDRS:?set ADMIN_CIDRS to the space-separated admin SSH CIDR(s)}"

tmp_ingress="$(mktemp)"; tmp_egress="$(mktemp)"
trap 'rm -f "$tmp_ingress" "$tmp_egress"' EXIT

# Cloudflare's VCN here is IPv4-only, so we only program IPv4 ranges. (An IPv6
# rule on an IPv4 VCN is rejected by OCI.)
cf4="$(curl -fsS https://www.cloudflare.com/ips-v4)"

python3 - "$cf4" "$ADMIN_CIDRS" "${WIDE_OPEN:-0}" >"$tmp_ingress" <<'PY'
import json, sys
cf4 = sys.argv[1].split()
admin = sys.argv[2].split()
wide = sys.argv[3] == "1"
def tcp(src, port):
    return {"source": src, "sourceType": "CIDR_BLOCK", "protocol": "6",
            "isStateless": False, "tcpOptions": {"destinationPortRange": {"min": port, "max": port}}}
if wide:
    rules = [tcp("0.0.0.0/0", p) for p in (22, 80, 443)]
else:
    rules = [tcp(a, 22) for a in admin]
    for cidr in cf4:
        rules += [tcp(cidr, 80), tcp(cidr, 443)]
json.dump(rules, sys.stdout)
PY

echo '[{"destination":"0.0.0.0/0","destinationType":"CIDR_BLOCK","protocol":"all","isStateless":false}]' >"$tmp_egress"

n=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$tmp_ingress")
echo "applying $n ingress rules to $SECURITY_LIST_ID …"
oci network security-list update --security-list-id "$SECURITY_LIST_ID" \
  --ingress-security-rules "file://$tmp_ingress" \
  --egress-security-rules "file://$tmp_egress" \
  --force >/dev/null
echo "done. verify: site 200 via Cloudflare; direct origin :80/:443 should now time out from a non-Cloudflare IP."
