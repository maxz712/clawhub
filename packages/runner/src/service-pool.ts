/**
 * Pooled backing services (Postgres + Redis) for the `services` (T2) verification
 * tier — boots a Change's changed process(es) against a REAL database WITHOUT a
 * privileged DinD build. A long-lived pooled Postgres serves a FRESH per-run
 * database (cloned from an empty template) behind a scoped, non-privileged role,
 * torn down with the run.
 *
 * SECURITY (the adversarial pre-enable review's must-fixes — multi-tenant isolation):
 *   • FAIL-CLOSED: every isolation SQL is checked; if CREATE ROLE / REVOKE CONNECT /
 *     GRANT fails, acquire releases + returns null and the caller falls back to dind.
 *     We never run untrusted code against an un-isolated DB because a step silently
 *     errored. (psql resolves {code} and never throws, so the old try/catch was inert.)
 *   • NO ID COLLISION: the per-run db/role name carries the FULL run-id entropy (a
 *     sha256 prefix), so two runs can never share a db/role/credential — which
 *     previously let one run's teardown DROP another run's live DB.
 *   • CSPRNG CREDS: the per-run password is crypto-random, never derived from the
 *     tenant-visible run id, and dollar-quoted so it can't break the CREATE ROLE SQL.
 *   • MAINTENANCE-DB LOCKDOWN: at warmup we REVOKE CONNECT on postgres/template1/the
 *     template + REVOKE ALL on public, so a per-run NOSUPERUSER role can reach ONLY
 *     its own DB — it can't connect to a sibling/system DB to read other tenants via
 *     shared catalogs. Each per-run DB also REVOKEs CONNECT FROM PUBLIC.
 *   • DEDICATED INTERNAL NET: the pool lives on its own `--internal` network (no
 *     host/internet egress); it is attached to a run ONLY via that run's per-run
 *     --internal network, NEVER the shared `bridge` (acquire refuses a non-internal
 *     network, so the egress-proxy escape hatch can't expose the pool to all runs).
 *   • SERIALIZED WARMUP: ensurePool runs once via a cached promise (no concurrent
 *     container rm/run race), never force-removes a Running pool container, and fails
 *     closed if Postgres never becomes ready.
 *   • ORPHAN REAPER: at warmup we sweep leftover verify_* DBs/roles from runs the
 *     `unless-stopped` pool outlived (a crash/SIGKILL that skipped releaseServices).
 *
 * Opt-in (default OFF until validated on a host): CLAWHUB_VERIFY_POOL=1. On disabled
 * or ANY failure acquire() returns null and the `services` tier degrades to the heavy
 * `dind` path — never silently runs without isolation.
 */
import { randomBytes, createHash } from "node:crypto";

const POOL_ENABLED = process.env.CLAWHUB_VERIFY_POOL === "1";
const PG_CONTAINER = "clawhub-verify-pg";
const REDIS_CONTAINER = "clawhub-verify-redis";
const POOL_NET = "clawhub-verify-pool";   // dedicated --internal net the pool lives on
const PG_IMAGE = process.env.CLAWHUB_VERIFY_PG_IMAGE ?? "postgres:16-alpine";
const REDIS_IMAGE = process.env.CLAWHUB_VERIFY_REDIS_IMAGE ?? "redis:7-alpine";
const PG_SUPER_PW = process.env.CLAWHUB_VERIFY_PG_PASSWORD ?? randomBytes(18).toString("base64url");
const TEMPLATE_DB = "clawhub_verify_template";

type Docker = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string; err: string }>;

let ensurePromise: Promise<boolean> | null = null;

/** Bring up the pool ONCE (cached promise — serializes the concurrent-first-use race). */
export async function ensurePool(docker: Docker): Promise<boolean> {
  if (!POOL_ENABLED) return false;
  if (!ensurePromise) ensurePromise = doEnsurePool(docker).catch(e => { ensurePromise = null; throw e; });
  return ensurePromise.catch(() => false);
}

async function doEnsurePool(docker: Docker): Promise<boolean> {
  // A dedicated INTERNAL network for the pool: no internet, not the shared bridge.
  await docker(["network", "create", "--internal", POOL_NET], 10_000).catch(() => {}); // ignore "exists"
  // Postgres — never force-remove a Running container.
  if ((await docker(["inspect", "-f", "{{.State.Running}}", PG_CONTAINER], 10_000)).out.trim() !== "true") {
    await docker(["rm", "-f", PG_CONTAINER], 10_000).catch(() => {});
    const r = await docker(["run", "-d", "--name", PG_CONTAINER, "--network", POOL_NET, "--restart", "unless-stopped",
      "--memory", "1g", "-e", `POSTGRES_PASSWORD=${PG_SUPER_PW}`, "-e", "POSTGRES_USER=clawhub", PG_IMAGE], 60_000);
    if (r.code !== 0) return false;
  }
  if ((await docker(["inspect", "-f", "{{.State.Running}}", REDIS_CONTAINER], 10_000)).out.trim() !== "true") {
    await docker(["rm", "-f", REDIS_CONTAINER], 10_000).catch(() => {});
    await docker(["run", "-d", "--name", REDIS_CONTAINER, "--network", POOL_NET, "--restart", "unless-stopped",
      "--memory", "256m", REDIS_IMAGE], 30_000);
  }
  // Wait for Postgres — FAIL CLOSED if it never comes up.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    if ((await docker(["exec", PG_CONTAINER, "pg_isready", "-U", "clawhub"], 5_000)).code === 0) { ready = true; break; }
    await new Promise(res => setTimeout(res, 1000));
  }
  if (!ready) return false;
  // Empty template + maintenance-DB lockdown so a per-run role can reach ONLY its own DB.
  await psqlOk(docker, "postgres", `CREATE DATABASE ${TEMPLATE_DB}`); // ignore "exists" (code checked below only for primitives)
  for (const sql of [
    `REVOKE CONNECT ON DATABASE postgres FROM PUBLIC`,
    `REVOKE CONNECT ON DATABASE template1 FROM PUBLIC`,
    `REVOKE CONNECT ON DATABASE ${TEMPLATE_DB} FROM PUBLIC`,
    `REVOKE ALL ON SCHEMA public FROM PUBLIC`,
  ]) await psqlOk(docker, "postgres", sql);
  await psqlOk(docker, "template1", `REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  await reapOrphans(docker).catch(() => {});
  return true;
}

/** Run psql; resolves {code,out,err} (never throws). */
async function psqlOk(docker: Docker, db: string, sql: string): Promise<{ code: number; out: string; err: string }> {
  return docker(["exec", "-e", `PGPASSWORD=${PG_SUPER_PW}`, PG_CONTAINER,
    "psql", "-v", "ON_ERROR_STOP=1", "-U", "clawhub", "-d", db, "-tAc", sql], 30_000);
}
/** Run psql and THROW on a non-zero exit — used for the isolation primitives so a
 *  silent SQL failure can never leave a run un-isolated. */
async function psqlMust(docker: Docker, db: string, sql: string): Promise<void> {
  const r = await psqlOk(docker, db, sql);
  if (r.code !== 0) throw new Error(`psql failed (${r.code}): ${sql.slice(0, 50)} :: ${r.err.slice(-160)}`);
}

// Full run-id entropy → no cross-run collision. sha256→24 hex is ample + fits a
// Postgres identifier (63 bytes). Deterministic only so release() recomputes it.
const idOf = (runId: string) => "r" + createHash("sha256").update(String(runId)).digest("hex").slice(0, 24);
const redisIdx = (id: string) => (parseInt(id.slice(1, 9), 16) >>> 0) % 16;

export interface AcquiredServices {
  dbUrl: string;       // DATABASE_URL for the verify env (scoped role)
  redisUrl: string;    // REDIS_URL (per-run logical index)
  hosts: string[];     // host:port pairs (reachable on the run's network)
}

/**
 * Mint a fresh per-run DB + scoped role and attach the pool to the run's network.
 * `network` MUST be a per-run --internal network — a "bridge"/empty network is
 * refused (the pool is never exposed on the shared bridge). Returns null (→ caller
 * falls back to dind) on disabled or ANY failure.
 */
export async function acquireServices(docker: Docker, runId: string, network: string): Promise<AcquiredServices | null> {
  if (!network || network === "bridge") return null;     // never put the pool on the shared bridge
  if (!(await ensurePool(docker))) return null;
  const id = idOf(runId);
  const dbName = `verify_${id}`;
  const role = `verify_${id}`;
  const pw = randomBytes(24).toString("base64url");      // CSPRNG, never derived from runId
  try {
    // Fresh empty DB; the Change's serve migrates it (db:push). A name clash throws.
    await psqlMust(docker, "postgres", `CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`);
    // Scoped, non-privileged role; password dollar-quoted so it can't break the SQL.
    await psqlMust(docker, "postgres", `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 20 PASSWORD $pw$${pw}$pw$`);
    await psqlMust(docker, "postgres", `REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`);
    await psqlMust(docker, "postgres", `GRANT CONNECT ON DATABASE ${dbName} TO ${role}`);
    await psqlMust(docker, dbName, `GRANT ALL ON SCHEMA public TO ${role}`);
    // Make the pool reachable on the run's per-run --internal network.
    const c1 = await docker(["network", "connect", network, PG_CONTAINER], 10_000);
    const c2 = await docker(["network", "connect", network, REDIS_CONTAINER], 10_000);
    if (c1.code !== 0 || c2.code !== 0) throw new Error(`network connect failed: ${c1.err || c2.err}`);
    return {
      dbUrl: `postgresql://${role}:${encodeURIComponent(pw)}@${PG_CONTAINER}:5432/${dbName}`,
      redisUrl: `redis://${REDIS_CONTAINER}:6379/${redisIdx(id)}`,
      hosts: [`${PG_CONTAINER}:5432`, `${REDIS_CONTAINER}:6379`],
    };
  } catch (e) {
    await releaseServices(docker, runId, network).catch(() => {});
    process.stderr.write(`[runner] pool acquire failed, falling back to dind: ${(e as Error).message}\n`);
    return null;
  }
}

/** Drop the per-run DB + role and detach the pool from the run's network. Detaches
 *  the network FIRST so the caller can then remove the per-run network cleanly. */
export async function releaseServices(docker: Docker, runId: string, network: string): Promise<void> {
  const id = idOf(runId);
  const dbName = `verify_${id}`;
  const role = `verify_${id}`;
  await docker(["network", "disconnect", "-f", network, PG_CONTAINER], 10_000).catch(() => {});
  await docker(["network", "disconnect", "-f", network, REDIS_CONTAINER], 10_000).catch(() => {});
  await psqlOk(docker, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}'`).catch(() => {});
  await psqlOk(docker, "postgres", `DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
  await psqlOk(docker, "postgres", `DROP ROLE IF EXISTS ${role}`).catch(() => {});
  await docker(["exec", REDIS_CONTAINER, "redis-cli", "-n", String(redisIdx(id)), "flushdb"], 10_000).catch(() => {});
}

/** Sweep verify_* DBs/roles the unless-stopped pool outlived (a crashed/killed run
 *  that skipped releaseServices) so leaked tenant state never accumulates. */
async function reapOrphans(docker: Docker): Promise<void> {
  const dbs = (await psqlOk(docker, "postgres", `SELECT datname FROM pg_database WHERE datname LIKE 'verify_%'`)).out.trim();
  for (const db of dbs.split("\n").map(s => s.trim()).filter(Boolean)) {
    await psqlOk(docker, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}'`).catch(() => {});
    await psqlOk(docker, "postgres", `DROP DATABASE IF EXISTS ${db}`).catch(() => {});
  }
  const roles = (await psqlOk(docker, "postgres", `SELECT rolname FROM pg_roles WHERE rolname LIKE 'verify_%'`)).out.trim();
  for (const r of roles.split("\n").map(s => s.trim()).filter(Boolean)) {
    await psqlOk(docker, "postgres", `DROP ROLE IF EXISTS ${r}`).catch(() => {});
  }
}
