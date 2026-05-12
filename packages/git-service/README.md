# @clawhub/git-service — Gitaly-style git tier

Go service that owns the on-disk bare repos for a shard. The Node API
(`packages/api`) routes Smart HTTP and internal RPCs to instances of this
service via `ShardMap` + `GitClient`.

## Backends

Two `gitops.Ops` implementations ship in the binary. Selected by env at boot.

| Backend | When to pick | What it does |
|---|---|---|
| `libgit2` *(default)* | Production. Anywhere libgit2 system libs are available. | All cold-path git ops (refs, init, merge, fetch-pack, apply-pack) run in-process via [git2go](https://github.com/libgit2/git2go). No fork-per-call. |
| `exec` | CGo-less builds; comparison runs. | Same operations shelled out to `git`. Matches the pre-libgit2 behavior. |

Switch with `CLAWHUB_GIT_BACKEND=libgit2|exec`.

The Smart HTTP wire protocol (`info/refs`, `git-upload-pack`,
`git-receive-pack`) bypasses libgit2 — see `internal/smarthttp.go`. We exec
`git-{receive,upload}-pack --stateless-rpc` directly rather than going
through `git http-backend` CGI. This is the Gitaly pattern: skip the
double-fork CGI overhead, keep `git`'s wire-protocol implementation (proven
across 20 years of clients), and let Go control the HTTP framing /
backpressure / sideband flush.

A future PR can replace the exec'd `receive-pack` with a native libgit2
implementation; the `gitops.Ops` interface doesn't need to change.

## Endpoints

| Path | Method | Backend used |
|---|---|---|
| `/healthz`, `/readyz` | GET | — |
| `/:ns/:repo.git/info/refs?service=git-upload-pack` | GET | exec `upload-pack --advertise-refs` |
| `/:ns/:repo.git/info/refs?service=git-receive-pack` | GET | exec `receive-pack --advertise-refs` |
| `/:ns/:repo.git/git-upload-pack` | POST | exec `upload-pack --stateless-rpc` |
| `/:ns/:repo.git/git-receive-pack` | POST | exec `receive-pack --stateless-rpc` (with the pre-receive hook writing the WAL) |
| `/internal/repos/init` | POST | `gitops.Init` |
| `/internal/repos/refs` | GET | `gitops.ListRefs` |
| `/internal/repos/update-ref` | POST | `gitops.UpdateRef` |
| `/internal/repos/delete-ref` | POST | `gitops.DeleteRef` |
| `/internal/repos/resolve-ref` | GET | `gitops.ResolveRef` |
| `/internal/repos/merge` | POST | `gitops.Merge` |
| `/internal/repos/fetch-pack` | POST | `gitops.FetchPack` |
| `/internal/repos/apply-pack` | POST | `gitops.ApplyPack` |
| `/internal/repos/mirror-clone` | POST | exec `git clone --bare --mirror` |

## Environment

| Var | Purpose |
|---|---|
| `CLAWHUB_GIT_SERVICE_ADDR` | Listen address. Default `:9000`. |
| `GIT_REPOS_BASE_PATH` | On-disk bare repo root. |
| `CLAWHUB_GIT_SERVICE_TOKEN` | Bearer token that the API must present. Required. |
| `CLAWHUB_GIT_BACKEND` | `libgit2` (default) or `exec`. |
| `CLAWHUB_SHARD_ID` | Identity this shard reports to leader-election + the pre-receive hook. |
| `CLAWHUB_API_BASE_URL` | API the pre-receive hook POSTs to. Hook is skipped if empty. |
| `CLAWHUB_INTERNAL_TOKEN` | HMAC secret shared with the API for the WAL hook. |

## Build

**Requires libgit2** unless you compile out the libgit2 backend (drop
`internal/gitops/libgit2.go` and the `git2go` import). On Alpine:

```sh
apk add --no-cache git gcc musl-dev libgit2-dev pkgconfig
CGO_ENABLED=1 go build -tags "static,system_libgit2" -o git-service ./cmd/server
```

On macOS:

```sh
brew install libgit2
CGO_ENABLED=1 go build -tags "static,system_libgit2" -o git-service ./cmd/server
```

The shipped `Dockerfile` does the right thing; `docker compose -f
docker-compose.dev.yml -f docker-compose.shards.yml up` brings up a
two-shard dev stack.

## Why not native libgit2 receive-pack today?

The libgit2 calls themselves (write packs, index packs, transact refs) are
straightforward. The piece you'd have to reimplement is the wire protocol:
pkt-line framing + capabilities negotiation + sideband-64k + push-option
+ shallow-fetch + multi-ack + report-status. That's ~1.5k lines of fiddly
protocol code that `git-receive-pack`/`git-upload-pack` already implement
correctly. Exec'ing the binary (instead of via `http-backend` CGI) is the
right middle ground for now.
