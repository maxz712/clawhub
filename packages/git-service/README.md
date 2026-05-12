# @clawhub/git-service — Gitaly-style git tier (Phase 3 SCAFFOLD)

> **Status:** Scaffold. Builds and serves; the receive-pack and upload-pack
> handlers proxy to `git http-backend` exactly like the Node API does today.
> This is the safe starting point for migrating git ops out of Node.
>
> Not yet implemented: in-process libgit2/go-git receive-pack, replication,
> Praefect-style consistency router, gRPC interface (HTTP-only for now to
> avoid pulling in the protoc toolchain in a scaffold).

## Why this exists

`packages/api` (Node/Hono) currently spawns `git http-backend` per push as a
child process. At AI-agent push volume this is the worst-shaped bottleneck:
process fork per request + Node event-loop contention from the streaming
proxy. The git-service package is the seam where we lift git operations onto
a Go fleet that can hold long-lived repo handles, run on goroutines, and be
sharded by repo with consistent hashing.

## Architecture (target)

```
┌──────────────┐    HTTP/2 + gRPC     ┌──────────────────┐
│ Hono router  │ ───────────────────▶ │  git-service     │
│ (Node)       │   ReceivePack        │  shard N         │
│              │   UploadPack         │  ┌────────────┐  │
│ Shard map    │   UpdateRef          │  │ bare repos │  │
│ in Postgres  │                      │  │ on local   │  │
└──────────────┘                      │  │ SSD        │  │
                                      │  └────────────┘  │
                                      └──────────────────┘
```

The router looks up `repoId → shardId` in the shard map
(`packages/api/src/services/shard-map.ts`) and forwards the request. Single
shard today; rebalance is `git clone --bare` plus a flip in the map.

## Running the scaffold

```bash
cd packages/git-service
go build -o git-service ./cmd/server
GIT_REPOS_BASE_PATH=./data/repos ./git-service
```

It will serve `/:ns/:repo.git/info/refs`, `/git-upload-pack`,
`/git-receive-pack` on `:9000` by default. Auth is a static bearer token
(`CLAWHUB_GIT_SERVICE_TOKEN`); the Node router signs requests with it after
verifying the agent JWT.

## What's done vs. not

Done:
- `cmd/server/main.go` — HTTP/2 server that wraps `git http-backend`.
- `internal/router.go` — namespace/repo routing.
- `internal/auth.go` — bearer-token verification against env-supplied token.
- Health endpoint, structured logs, graceful shutdown.

Not yet done (deliberately deferred for later PRs):
- gRPC surface (use the proto in `proto/git.proto` as a sketch).
- In-process git ops via go-git or libgit2 — current handler still execs git.
- Replication / Praefect-style consistency router.
- Streaming with explicit backpressure (relies on net/http for now).
