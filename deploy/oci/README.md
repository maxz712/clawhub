# OCI production ops (clawhub-prod)

Production runs on an OCI Always-Free A1 instance (`clawhub-prod`,
167.234.210.125, 2 OCPU / 12 GB — the free ceiling, provably $0). Public path:
Cloudflare (proxied) → origin Caddy → compose stack. This dir holds the
infra automation that keeps it locked down and at $0.

## Edge firewall — origin reachable only via Cloudflare

The OCI subnet Security List restricts ingress so the origin can't be hit
directly (which would bypass Cloudflare's WAF + rate-limit via a spoofed Host
header) and SSH isn't open to the world. Applied live 2026-06-20.

```bash
export SECURITY_LIST_ID=ocid1.securitylist.oc1.us-sanjose-1.aaaaaaaa5uvorredjj4zjaifzgaw3r7puksy4vqjtva3fj2audafr4ffsdla
export ADMIN_CIDRS="72.142.18.42/32 97.113.244.228/32"   # admin IPs allowed to SSH
./cf-ingress.sh        # 80/443 → Cloudflare IPv4 ranges only; 22 → ADMIN_CIDRS
```

Re-run periodically (Cloudflare ranges change rarely) — it's idempotent. Verify:
`curl -I https://useclawhub.com` is 200, but `curl --max-time 8 http://167.234.210.125:80`
and `openssl s_client -connect 167.234.210.125:443` from a non-Cloudflare IP both
time out. **Rollback / re-open** (the lockout backstop — OCI CLI works without
SSH): `WIDE_OPEN=1 ./cf-ingress.sh` reopens 22/80/443 to `0.0.0.0/0`.

## $0 watchdog — reactive auto-stop

Three layers guard $0: (1) a compartment **quota** caps billable resources
(preventive, off-host), (2) a **budget + ONS email alert** at $0.01 (detective,
off-host, email confirmed), and (3) this **watchdog** (reactive: alerts on any
spend + SOFTSTOPs non-allowlisted running instances). Layers 1+2 are the primary
protection and live off-host, so they survive any host change.

The watchdog used to run on debian-server. To survive debian going cold-standby,
relocate it onto the OCI host using **instance principals** (no API key on disk):

```bash
# 1. one-time: dynamic group + policy so the instance can call OCI APIs as itself
oci iam dynamic-group create --name clawhub-watchdog \
  --description "clawhub-prod instance principal" \
  --matching-rule "instance.id = '<clawhub-prod instance OCID>'"
oci iam policy create --name clawhub-watchdog --compartment-id <TENANCY_OCID> \
  --statements '["Allow dynamic-group clawhub-watchdog to read usage-reports in tenancy","Allow dynamic-group clawhub-watchdog to use instances in tenancy","Allow dynamic-group clawhub-watchdog to manage ons-topics in tenancy"]' \
  --description "clawhub spend watchdog"

# 2. on the host: install OCI CLI, copy this dir to ~/oci-watchdog,
#    put the A1 instance OCID in allowlist.txt (hard-whitelist — never stopped),
#    then cron it every 15 min:
#    */15 * * * * TENANCY_OCID=… ONS_TOPIC_ID=… ~/oci-watchdog/watchdog.sh >> ~/oci-watchdog/watchdog.log 2>&1
```

`allowlist.txt` is **fail-safe**: with no `ocid1.instance.` line the watchdog
only alerts (never stops), so a fresh instance can't be killed before it's
whitelisted. The clawhub-prod A1 is hard-whitelisted by OCID.

## Decommissioning debian-server (cold standby)

debian-server was the prior prod host + hot fallback. Once the watchdog is
relocated (above) and a fresh DB+repos backup is confirmed restorable, on the
debian LAN (`ssh -t serveradmin@192.168.0.150`):

1. `cd ~/clawhub && docker compose down` — stop its public stack.
2. Confirm its cloudflare-ddns cron is removed (`crontab -l`) so DNS can't flap
   back to debian's IP.
3. Firewall its public ingress (it serves no public traffic now).
4. Keep the box **powered** for manual restore (cold standby). Instant rollback
   via a Cloudflare A-record flip is gone; recovery is restore-from-backup onto
   a fresh host (or power debian's stack back up).
