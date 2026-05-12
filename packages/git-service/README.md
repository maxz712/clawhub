# @clawhub/git-service — Gitaly-style git tier

Go service that owns the on-disk bare repos for a shard. The Node API
(`packages/api`) routes Smart HTTP and internal RPCs to instances of this
service via `ShardMap` + `GitClient`.

## What it does today

- Serves git Smart HTTP (`info/refs`, `git-upload-pack`, `git-receive-pack`)
  for repos under `GIT_REPOS_BASE_PATH`. Today this still execs
  `git http-backend`; the seam is in `internal/proxy.go` and is the
  natural place to swap in a native libgit2/git2go receive-pack.
- Internal HTTP API consumed by the Node router:
  - `POST /internal/repos/init` — create a bare repo + install the
    pre-receive hook
  - `GET  /internal/repos/refs?prefix=…` — list refs
  - `POST /internal/repos/{update,delete}-ref` — atomic CAS / delete
  - `GET  /internal/repos/resolve-ref` — rev-parse
  - `POST /internal/repos/merge` — server-side merge (merge/squash/rebase)
  - `POST /internal/repos/fetch-pack` — `pack-objects --stdout` for SHAs
  - `POST /internal/repos/apply-pack` — `index-pack --stdin --fix-thin`
  - `POST /internal/repos/mirror-clone` — `git clone --bare --mirror`
- Auto-installs a pre-receive shell hook on every repo it manages. The
  hook posts ref updates to the API's `/api/v1/internal/ref-log`
  endpoint with an HMAC signature. A non-2xx response **rejects the push**
  — Phase 4 Postgres-as-WAL.

## What's deliberately not yet in this package

- **Native libgit2/git2go receive-pack and upload-pack.** Shipping a real
  CGo libgit2 build is its own engagement: vendor pinning, CVE
  patching, cross-compilation. The existing `git http-backend` exec is
  correct, just slower per-push than native. Replace `internal/proxy.go`
  when this becomes the bottleneck.
- **gRPC.** `proto/git.proto` is a sketch of the eventual surface; the
  HTTP API is enough for the Node router and avoids pulling in the buf
  toolchain in this PR.

## Environment

| Var | Purpose |
|---|---|
| `CLAWHUB_GIT_SERVICE_ADDR` | Listen address. Default `:9000`. |
| `GIT_REPOS_BASE_PATH` | On-disk bare repo root. |
| `CLAWHUB_GIT_SERVICE_TOKEN` | Bearer token that the API must present. Required. |
| `CLAWHUB_SHARD_ID` | Identity this shard reports to leader-election + the hook. |
| `CLAWHUB_API_BASE_URL` | API the pre-receive hook POSTs to. Hook is skipped if empty. |
| `CLAWHUB_INTERNAL_TOKEN` | HMAC secret shared with the API for the WAL hook. |

## Build & run

```bash
# Dev build
go build -o git-service ./cmd/server
CLAWHUB_GIT_SERVICE_TOKEN=dev ./git-service

# Docker image (used by the Helm chart + docker-compose.shards.yml)
docker build -t ghcr.io/clawhub/git-service:latest .
```

## Operator UX from the Node side

```bash
clawhub shards add shard-0 http://git-shard-0:9000
clawhub shards add shard-1 http://git-shard-1:9000 --role replica
clawhub shards status
clawhub shards drain shard-0
clawhub shards promote <repoId> shard-1
clawhub backup run <repoId>
```
