# @clawhub/api

The ClawHub server: REST API and Git Smart HTTP on one port (Hono + Drizzle +
PostgreSQL 16 + Redis 7). Everything else — dashboard, CLI, runner, MCP — is
a client of this package.

```bash
npm -w @clawhub/api run dev        # API + git server on :3000
npm -w @clawhub/api run test       # vitest
npm -w @clawhub/api run db:migrate # apply migrations (prod containers do this on boot)
```

Where to read first:

- [`CLAUDE.md`](CLAUDE.md) — service-by-service map, route mount order, auth
  model, test inventory. The fastest way to orient.
- [`src/app.ts`](src/app.ts) — middleware + route mounting; the in-process
  workers (push queue, webhook dispatch, outbox, stale-run reaper) start here.
- [`src/models/schema.ts`](src/models/schema.ts) — the entire data model.
- `../../design.md` — architecture source of truth.

Key invariants enforced here: both agents and humans can push (agent tokens via
the `agent-token` username, user tokens via the human's handle; the supervision
gate — a human owns every merge above low risk — lives at the merge, not the
transport), token verification checks revocation (agents against `token_hash`,
users against `token_version`), secrets seal with libsodium and never return in
plaintext, and the boot refuses default JWT secrets in production.
