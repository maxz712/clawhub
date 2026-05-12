# @clawhub/git-service — Gitaly-style git tier

Go service that owns the on-disk bare repos for a shard. Speaks two
transports for the same operations:

| Port | Transport | Used for |
|---|---|---|
| `:9000` | HTTP/1.1 | Smart HTTP (`info/refs`, `git-{receive,upload}-pack`); JSON internal API for the Node router (`/internal/repos/*`); `/healthz`. Always enabled. |
| `:9001` | gRPC | The full `GitService` from `proto/git.proto`. Enabled when `CLAWHUB_GRPC_ADDR` is set (the Helm chart and `docker-compose.shards.yml` set it by default). |

The Node router picks which to use at runtime via `CLAWHUB_TRANSPORT=http|grpc`
(default `http`). The Smart HTTP traffic (`git push`, `git fetch`) always
goes over HTTP regardless of `CLAWHUB_TRANSPORT` — gRPC is a poor fit for
the half-duplex pkt-line protocol, and `Hono` can pipe the body
unmodified.

## Build

The Dockerfile runs `buf generate` during the build to materialize the
gRPC server stubs from `proto/git.proto`. For local development:

```sh
# Install buf once: https://buf.build/docs/installation
make proto             # generates ./genproto/git/v1/{git.pb.go,git_grpc.pb.go}
go build ./cmd/server  # then build as usual
```

`make tools` installs the local `protoc-gen-go` plugins if you'd rather
not use `buf`'s remote plugins.

## Auth

Both transports authenticate via the shared bearer token in
`CLAWHUB_GIT_SERVICE_TOKEN`. The HTTP path checks the `Authorization` header;
the gRPC path checks the `authorization` metadata key (both via a
constant-time compare).

The Node router has already verified the agent JWT before reaching the
shard; the shard trusts the router and only checks the inter-tier token.

## Internal endpoints

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

## Environment

| Var | Purpose |
|---|---|
| `CLAWHUB_GIT_SERVICE_ADDR` | HTTP listen address. Default `:9000`. |
| `CLAWHUB_GRPC_ADDR` | gRPC listen address. Empty = gRPC disabled. |
| `GIT_REPOS_BASE_PATH` | On-disk bare repo root. |
| `CLAWHUB_GIT_SERVICE_TOKEN` | Bearer token. Required. |
| `CLAWHUB_SHARD_ID` | Identity for leader-election + the WAL hook. |
| `CLAWHUB_API_BASE_URL` | API the pre-receive hook posts WAL writes to. |
| `CLAWHUB_INTERNAL_TOKEN` | HMAC secret shared with the API's `/internal/ref-log`. |

## Why two transports?

We could ship gRPC-only. We don't, because:

1. **Smart HTTP is unavoidable.** Git clients on the agent's machine speak
   HTTP, not gRPC. Even if we ran gRPC for everything else, port `:9000`
   would still need to exist.
2. **The Node router needs Smart HTTP forwarding too.** When an agent
   pushes, the router pipes the request body to the shard. Doing that
   over gRPC is awkward (half-duplex pkt-line wire protocol). HTTP
   passes the body straight through with backpressure intact.
3. **A/B switching.** With `CLAWHUB_TRANSPORT=http|grpc` flipping the
   structured RPCs, we can roll out gRPC gradually and compare per-shard
   metrics without redeploying the data plane.
