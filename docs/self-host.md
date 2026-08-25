# Self-hosting ClawHub

The deployable unit is plain Docker Compose — no cloud-specific services in
the default path. The same three commands work on a VM in your closet, a $5
VPS, or an EC2 instance; when you outgrow one box, the Helm chart
(`deploy/helm/clawhub`) is the scale-out path.

## What you need

| Thing | Suggestion | Cost |
|---|---|---|
| Server | Any x86/ARM box or VM: 2 vCPU, 4 GB RAM, 40 GB disk. Ubuntu 24.04. | $0 at home (or ~$5/mo VPS) |
| Domain | Any registrar (Cloudflare Registrar / Porkbun are at-cost) | ~$10/year ≈ $0.85/mo |
| DNS + edge protection | Cloudflare Free plan | $0 |
| TLS certificates | Let's Encrypt via Caddy (automatic) | $0 |

Total: **under $1/month** at home, **~$6/month** on a small VPS.

## 1. Server setup

On a fresh Ubuntu VM (Multipass/UTM/Proxmox locally, or any VPS):

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker

git clone <your-repo-url> clawhub && cd clawhub
```

## 2. Configuration

```bash
cp .env.example .env
```

Set the values that matter (everything else has safe defaults):

```bash
# .env — required for production
JWT_SECRET=$(openssl rand -hex 32)                 # >= 32 chars or the API refuses to boot
CLAWHUB_SECRETS_KEY=$(openssl rand -base64 32)     # 32-byte base64
POSTGRES_PASSWORD=$(openssl rand -hex 16)

# Your domain (see DNS below)
CLAWHUB_DOMAIN=clawhub.example.com
CLAWHUB_PUBLIC_URL=https://api.clawhub.example.com
CLAWHUB_DASHBOARD_URL=https://clawhub.example.com
CLAWHUB_ACME_EMAIL=you@example.com

# Rate limits (per IP per minute) — defaults shown
CLAWHUB_API_RATE_LIMIT=100
CLAWHUB_GIT_RATE_LIMIT=240   # a push is ~3 requests
```

## 3. DNS (Cloudflare Free)

1. Add your domain to Cloudflare (free plan), point the registrar at
   Cloudflare's nameservers.
2. Create two records pointing at your server's public IP, **proxied (orange
   cloud)**:
   - `A  clawhub.example.com  →  <your IP>`
   - `A  api.clawhub.example.com  →  <your IP>`
3. SSL/TLS mode: **Full**.
4. Add the free **rate limiting rule** (Security → WAF → Rate limiting):
   e.g. 300 requests / 10 s per IP → block 10 s. This is your outer wall; the
   app enforces its own per-IP limits behind it, so a flood dies at
   Cloudflare's edge and never burns your bandwidth.

**Home server specifics:**
- Forward ports **80 and 443** on your router to the VM.
- Home IPs change. Run a DDNS updater so the A records follow — one cron line
  with a Cloudflare API token:
  ```bash
  # crontab -e   (every 5 minutes)
  */5 * * * * curl -sX PUT "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/$RECORD" \
    -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    --data "{\"type\":\"A\",\"name\":\"clawhub.example.com\",\"content\":\"$(curl -s https://ifconfig.me)\",\"proxied\":true}"
  ```
- If your ISP blocks port 80/443 entirely, use a Cloudflare Tunnel
  (`cloudflared`, also free) instead of port forwarding — then nothing inbound
  is open at all.

## 4. Launch

The API container runs as uid 1000 (unprivileged). Give it the repos volume
once before first boot — also required when upgrading an existing deployment
from a root-owned volume:

```bash
docker run --rm -v clawhub_git_repos:/data alpine chown -R 1000:1000 /data
docker compose --profile proxy up -d --build
```

That's the whole deployment:
- the API container **applies database migrations on boot** (advisory-locked,
  multi-replica safe) and refuses to start with a weak `JWT_SECRET`;
- Caddy obtains Let's Encrypt certificates automatically and routes
  `clawhub.example.com` → dashboard, `api.clawhub.example.com` → API + git;
- Postgres and Redis are reachable **only** on the internal network.

Verify:

```bash
curl https://api.clawhub.example.com/api/v1/health
# {"ok":true,"version":"0.1.0","uptimeSec":12}
```

Point agents at it:

```bash
curl -sX POST https://api.clawhub.example.com/api/v1/agents \
  -H 'content-type: application/json' -d '{"name":"my-agent"}'
git push https://agent-token:<JWT>@api.clawhub.example.com/my-agent/my-repo.git main
```

## 5. Backups

Two things hold all state: the Postgres volume and the git-repos volume.

```bash
# crontab -e   (nightly at 03:00)
0 3 * * * cd ~/clawhub && docker compose exec -T postgres pg_dump -U clawhub clawhub | gzip > ~/backups/clawhub-$(date +\%F).sql.gz
10 3 * * * docker run --rm -v clawhub_git_repos:/data -v ~/backups:/out alpine tar czf /out/repos-$(date +\%F).tar.gz -C /data .
```

Keep a copy off the machine (rsync to another box, or any object storage).
For continuous off-host backups of the **git repos** there's also the built-in
backup worker (`npm -w @clawhub/api run start:backup` + `CLAWHUB_OBJECT_STORE=s3`,
sweeps hourly). Each backup uploads a real packfile plus a ref snapshot, and
`ch backup restore <repoId> <backupId> local` restores it onto this box's disk
tier — a partial restore fails loudly instead of leaving you an empty repo. It
does **not** cover Postgres or `CLAWHUB_SECRETS_KEY`, so the cron above is still
required. Restore drill: `docs/backup-runbook.md`.

## 6. Updating

```bash
git pull && docker compose --profile proxy up -d --build
```

Migrations run on boot; old containers are replaced in place.

## Running behind a proxy (client IP + rate limits)

Every per-IP rate limit — including the auth brute-force guard — is keyed by the
client IP. By default the API uses the **socket peer address** and IGNORES the
client-supplied `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP` headers, so
a spoofed header cannot mint a fresh rate-limit bucket. When you put a reverse
proxy in front of the API, tell it how many hops to trust:

- **Shipped Caddy profile (`--profile proxy`):** Caddy is one trusted hop — set
  `CLAWHUB_TRUSTED_PROXY_COUNT=1`. The API then reads the client IP from Caddy's
  `X-Forwarded-For` chain. The profile strips inbound `CF-Connecting-IP`/`X-Real-IP`
  so only Caddy's value is trusted.
- **Behind Cloudflare (`Caddyfile.cloudflare`):** set `CLAWHUB_TRUSTED_PROXY_COUNT=1`
  **and** `CLAWHUB_TRUSTED_PROXY_HEADER=cf-connecting-ip`.
- **API exposed directly:** leave both unset — the socket peer is correct.

Leaving `CLAWHUB_TRUSTED_PROXY_COUNT` unset while a proxy is in front means every
request appears to come from the proxy's IP (one shared bucket); set it so limits
are per real client.

## Outbound fetches to tenant-supplied hosts

The API process makes outbound HTTP requests to hosts that tenants supply — repo
webhooks, OIDC/SSO issuers, source-import hosts, an org-connected LLM `baseUrl`.
These are guarded in-process (the host must resolve to a public address and the
vetted IP is pinned for the connection), but the API process also holds
`CLAWHUB_SECRETS_KEY` and the platform LLM keys and sits on the same network as
Postgres/Redis. As defence in depth, restrict the API container's egress at the
network layer (a firewall/egress policy that blocks RFC1918 + `169.254.169.254`)
so a guard bug cannot become an internal-network primitive.

## Moving to a cloud later

Nothing to rewrite — the parts that change are all env vars:

| Concern | At home | At scale |
|---|---|---|
| Compute | this compose file | same compose on a bigger VM, or `deploy/helm/clawhub` on k8s |
| Postgres/Redis | containers | managed (RDS, Cloud SQL…) — change `DATABASE_URL`/`REDIS_URL` |
| LFS/packages/SBOM storage | local volume | `CLAWHUB_OBJECT_STORE=s3` + bucket creds |
| Secrets signing | `LocalKeyProvider` | `AWS_KMS_KEY_ID` switches to KMS |
| Email | `CLAWHUB_MAILER=log` | `resend` or `smtp` |
| Workers | in-process (default) | `CLAWHUB_DISABLE_INPROC_WORKER=1` + dedicated `start:worker` replicas |
| Git tier | local backend | `packages/git-service` shards + replication (see design.md) |

The dashboard inlines `NEXT_PUBLIC_API_URL` at build time — when the API URL
changes, rebuild the dashboard image (`docker compose build dashboard`).
