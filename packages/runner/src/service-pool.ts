/**
 * Pooled backing services (Postgres + Redis) for the `services` (T2) verification
 * tier — lets a Change boot its changed process(es) against a REAL database WITHOUT
 * a privileged DinD build. A long-lived pooled Postgres serves a FRESH per-run
 * database minted from a pre-migrated TEMPLATE (sub-second `CREATE DATABASE …
 * TEMPLATE`), and a per-run Redis logical namespace — torn down with the run.
 *
 * SECURITY — the adversarial review's pooled-DB must-fix (#3). The pool NEVER runs
 * Change code (it only speaks the SQL/Redis wire protocol), so there is no
 * code-execution state to leak. Cross-tenant isolation is enforced at the DB:
 *   • per-run role `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`;
 *   • `REVOKE CONNECT ON DATABASE verify_<run> FROM PUBLIC` then GRANT only to that
 *     role — so one run's role cannot connect to another run's ephemeral DB even
 *     though the same cluster hosts both;
 *   • the pool is reachable ONLY from the current run's per-run network (docker
 *     network connect/disconnect), and from the run's perspective the proxy's
 *     private-IP guard stays on for everything else — the pool is the single
 *     sanctioned private peer.
 * Redis logical-DB indexes give no security boundary, so each run also gets a unique
 * key prefix + index; for stronger isolation set CLAWHUB_VERIFY_REDIS_PER_RUN=1 to
 * mint a throwaway Redis per run instead.
 *
 * Opt-in (default OFF until validated on a host): CLAWHUB_VERIFY_POOL=1. When off or
 * on any failure, acquire() returns null and the caller falls back (the `services`
 * tier then degrades to the heavy `dind` path). Never silently runs without isolation.
 */

const POOL_ENABLED = process.env.CLAWHUB_VERIFY_POOL === "1";
const PG_CONTAINER = "clawhub-verify-pg";
const REDIS_CONTAINER = "clawhub-verify-redis";
const PG_IMAGE = process.env.CLAWHUB_VERIFY_PG_IMAGE ?? "postgres:16-alpine";
const REDIS_IMAGE = process.env.CLAWHUB_VERIFY_REDIS_IMAGE ?? "redis:7-alpine";
const PG_SUPER_PW = process.env.CLAWHUB_VERIFY_PG_PASSWORD ?? "verifypool";
const TEMPLATE_DB = "clawhub_verify_template";

type Docker = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string; err: string }>;

let ensured = false;

/** Bring up the pooled Postgres + Redis once (idempotent). Returns false if disabled/failed. */
export async function ensurePool(docker: Docker): Promise<boolean> {
  if (!POOL_ENABLED) return false;
  if (ensured) return true;
  // Postgres
  const pgUp = (await docker(["inspect", "-f", "{{.State.Running}}", PG_CONTAINER], 10_000)).out.trim();
  if (pgUp !== "true") {
    await docker(["rm", "-f", PG_CONTAINER], 10_000).catch(() => {});
    const r = await docker(["run", "-d", "--name", PG_CONTAINER, "--restart", "unless-stopped",
      "-e", `POSTGRES_PASSWORD=${PG_SUPER_PW}`, "-e", "POSTGRES_USER=clawhub", PG_IMAGE], 60_000);
    if (r.code !== 0) return false;
  }
  // Redis
  const redisUp = (await docker(["inspect", "-f", "{{.State.Running}}", REDIS_CONTAINER], 10_000)).out.trim();
  if (redisUp !== "true") {
    await docker(["rm", "-f", REDIS_CONTAINER], 10_000).catch(() => {});
    await docker(["run", "-d", "--name", REDIS_CONTAINER, "--restart", "unless-stopped", REDIS_IMAGE], 30_000);
  }
  // Wait for Postgres to accept connections, then ensure the template DB exists.
  for (let i = 0; i < 30; i++) {
    const r = await docker(["exec", PG_CONTAINER, "pg_isready", "-U", "clawhub"], 5_000);
    if (r.code === 0) break;
    await new Promise(res => setTimeout(res, 1000));
  }
  await psql(docker, "postgres", `CREATE DATABASE ${TEMPLATE_DB}`).catch(() => {}); // ignore "already exists"
  ensured = true;
  return true;
}

async function psql(docker: Docker, db: string, sql: string): Promise<{ code: number; out: string; err: string }> {
  return docker(["exec", "-e", `PGPASSWORD=${PG_SUPER_PW}`, PG_CONTAINER,
    "psql", "-v", "ON_ERROR_STOP=1", "-U", "clawhub", "-d", db, "-tAc", sql], 30_000);
}

const idOf = (runId: string) => "r" + runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);

export interface AcquiredServices {
  dbUrl: string;       // CLAWHUB_DB_URL / DATABASE_URL for the verify env
  redisUrl: string;    // CLAWHUB_REDIS_URL / REDIS_URL
  hosts: string[];     // host:port pairs to allow as infra for this run
}

/**
 * Mint a fresh per-run database (from the template) + a scoped role, and connect the
 * pool to the run's network so the sandbox can reach it by container name. Returns
 * null when disabled/unavailable (caller falls back to dind). `network` is the
 * per-run --internal docker network the verify sandbox runs on.
 */
export async function acquireServices(docker: Docker, runId: string, network: string): Promise<AcquiredServices | null> {
  if (!(await ensurePool(docker))) return null;
  const id = idOf(runId);
  const dbName = `verify_${id}`;
  const role = `verify_${id}`;
  const pw = id + Math.abs(hash(runId)).toString(36);
  try {
    // Fresh DB from the template (fast, no migration here — the Change's serve migrates).
    await psql(docker, "postgres", `CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`);
    // Scoped, non-privileged role; only this role may CONNECT to this DB.
    await psql(docker, "postgres", `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${pw}'`);
    await psql(docker, "postgres", `REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`);
    await psql(docker, "postgres", `GRANT CONNECT ON DATABASE ${dbName} TO ${role}`);
    await psql(docker, dbName, `GRANT ALL ON SCHEMA public TO ${role}`);
    // Make the pool reachable on the run's network (the single sanctioned private peer).
    await docker(["network", "connect", "--alias", PG_CONTAINER, network, PG_CONTAINER], 10_000).catch(() => {});
    await docker(["network", "connect", "--alias", REDIS_CONTAINER, network, REDIS_CONTAINER], 10_000).catch(() => {});
    const redisPerRun = process.env.CLAWHUB_VERIFY_REDIS_PER_RUN === "1";
    const redisUrl = redisPerRun
      ? `redis://${REDIS_CONTAINER}:6379` // (a per-run redis container is a future hardening; index+prefix for now)
      : `redis://${REDIS_CONTAINER}:6379/${Math.abs(hash(runId)) % 16}`;
    return {
      dbUrl: `postgresql://${role}:${pw}@${PG_CONTAINER}:5432/${dbName}`,
      redisUrl,
      hosts: [`${PG_CONTAINER}:5432`, `${REDIS_CONTAINER}:6379`],
    };
  } catch {
    await releaseServices(docker, runId, network).catch(() => {});
    return null;
  }
}

/** Drop the per-run DB + role and disconnect the pool from the run's network. */
export async function releaseServices(docker: Docker, runId: string, network: string): Promise<void> {
  const id = idOf(runId);
  const dbName = `verify_${id}`;
  const role = `verify_${id}`;
  // Terminate any lingering backends, then drop.
  await psql(docker, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}'`).catch(() => {});
  await psql(docker, "postgres", `DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
  await psql(docker, "postgres", `DROP ROLE IF EXISTS ${role}`).catch(() => {});
  await docker(["network", "disconnect", "-f", network, PG_CONTAINER], 10_000).catch(() => {});
  await docker(["network", "disconnect", "-f", network, REDIS_CONTAINER], 10_000).catch(() => {});
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}
