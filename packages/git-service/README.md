# @clawhub/git-service — Gitaly-style git tier

Go service that owns the on-disk bare repos for a shard. Two dimensions of
flexibility:

- **Backends** (`CLAWHUB_GIT_BACKEND=libgit2|exec`, default `libgit2`):
  selects how the cold-path git ops (refs / init / merge / pack-objects /
  index-pack) run inside the binary.
- **Transports** (`CLAWHUB_TRANSPORT=http|grpc` on the Node side, default
  `http`): selects how the Node router talks to the shard. The shard
  always serves HTTP; gRPC is additionally enabled when `CLAWHUB_GRPC_ADDR`
  is set.

| Port | Transport | Used for |
|---|---|---|
| `:9000` | HTTP/1.1 | Smart HTTP (`info/refs`, `git-{receive,upload}-pack`); JSON internal API for the Node router (`/internal/repos/*`); `/healthz`. Always enabled. |
| `:9001` | gRPC | The full `GitService` from `proto/git.proto`. Enabled when `CLAWHUB_GRPC_ADDR` is set (the Helm chart and `docker-compose.shards.yml` set it by default). |

The Smart HTTP traffic (`git push`, `git fetch`) always goes over HTTP
regardless of `CLAWHUB_TRANSPORT` — gRPC is a poor fit for the
half-duplex pkt-line wire protocol.

## Backends

`gitops.Ops` has two implementations. Selected by env at boot.

| Backend | When to pick | What it does |
|---|---|---|
| `libgit2` *(default)* | Production. Anywhere libgit2 system libs are available. | Cold-path git ops (refs, init, merge, fetch-pack, apply-pack) run in-process via [git2go](https://github.com/libgit2/git2go). No fork-per-call. |
| `exec` | CGo-less builds; comparison runs. | Same operations shelled out to `git`. Matches the pre-libgit2 behavior. |

Both transports (HTTP and gRPC) consult the same `gitops.Ops` instance,
so switching `CLAWHUB_TRANSPORT` never changes semantics.

The Smart HTTP wire protocol bypasses libgit2 — see
`internal/smarthttp.go`. We exec `git-{receive,upload}-pack
--stateless-rpc` directly rather than going through `git http-backend`
CGI. This is the Gitaly pattern: skip the double-fork CGI overhead, keep
`git`'s wire-protocol implementation (proven across 20 years of clients),
and let Go control the HTTP framing / backpressure / sideband flush.

A future PR can replace the exec'd `receive-pack` with a native libgit2
implementation; the `gitops.Ops` interface doesn't need to change.

## Internal operations

| Op | HTTP | gRPC |
|---|---|---|
| Create bare repo | `POST /internal/repos/init` | `Init` |
| List refs | `GET /internal/repos/refs?prefix=` | `ListRefs` |
| Resolve ref | `GET /internal/repos/resolve-ref` | `ResolveRef` |
| CAS update ref | `POST /internal/repos/update-ref` | `UpdateRef` |
| Delete ref | `POST /internal/repos/delete-ref` | `DeleteRef` |
| Server-side merge | `POST /internal/repos/merge` | `Merge` |
| Pack-objects | `POST /internal/repos/fetch-pack` | `FetchPack` (server-streaming) |
| Index-pack | `POST /internal/repos/apply-pack` | `ApplyPack` (client-streaming) |
| Mirror clone | `POST /internal/repos/mirror-clone` | `MirrorClone` |
| Health | `GET /healthz` | `Health` |

## Build

Requires libgit2 system libs unless you compile out the libgit2 backend
(drop `internal/gitops/libgit2.go` and the `git2go` import).

```sh
# Local dev — generate gRPC stubs once after editing proto/, then build.
make proto                  # requires `buf` (https://buf.build/docs/installation)
make build                  # CGO_ENABLED=1 go build -tags static,system_libgit2 ...

# Alpine
apk add --no-cache git make gcc musl-dev libgit2-dev pkgconfig
make proto && make build

# macOS
brew install libgit2 buf
make proto && make build
```

The shipped `Dockerfile` runs `buf generate` then builds with both libgit2
and gRPC support. `docker compose -f docker-compose.dev.yml -f
docker-compose.shards.yml up` brings up a two-shard dev stack with gRPC
enabled.

## Auth

Both transports authenticate via the shared bearer token in
`CLAWHUB_GIT_SERVICE_TOKEN`. The HTTP path checks the `Authorization`
header; the gRPC path checks the `authorization` metadata key (both via a
constant-time compare).

The Node router has already verified the agent JWT before reaching the
shard; the shard trusts the router and only checks the inter-tier token.

## Environment

| Var | Purpose |
|---|---|
| `CLAWHUB_GIT_SERVICE_ADDR` | HTTP listen address. Default `:9000`. |
| `CLAWHUB_GRPC_ADDR` | gRPC listen address. Empty = gRPC disabled. |
| `GIT_REPOS_BASE_PATH` | On-disk bare repo root. |
| `CLAWHUB_GIT_SERVICE_TOKEN` | Bearer token that the API must present. Required. |
| `CLAWHUB_GIT_BACKEND` | `libgit2` (default) or `exec`. |
| `CLAWHUB_SHARD_ID` | Identity this shard reports to leader-election + the pre-receive hook. |
| `CLAWHUB_API_BASE_URL` | API the pre-receive hook POSTs to. Hook is skipped if empty. |
| `CLAWHUB_INTERNAL_TOKEN` | HMAC secret shared with the API for the WAL hook. |

## Why two transports?

We could ship gRPC-only. We don't, because:

1. **Smart HTTP is unavoidable.** Git clients on the agent's machine speak
   HTTP, not gRPC. Port `:9000` has to exist.
2. **The Node router needs Smart HTTP forwarding too.** When an agent
   pushes, the router pipes the request body to the shard. Doing that
   over gRPC is awkward (half-duplex pkt-line wire protocol). HTTP passes
   the body straight through with backpressure intact.
3. **A/B switching.** With `CLAWHUB_TRANSPORT=http|grpc` flipping the
   structured RPCs, we can roll out gRPC gradually and compare per-shard
   metrics without redeploying the data plane.
