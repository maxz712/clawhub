import { fileURLToPath } from "node:url";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Applies pending migrations from the drizzle/ folder and exits. Used by the
// production container entrypoint (`node dist/migrate.js && node dist/index.js`)
// so a fresh deploy gets its schema without drizzle-kit (a dev dependency).
// Shares drizzle-kit's migrations table, so `npm run db:migrate` and this
// script are interchangeable.
const url = process.env.DATABASE_URL ?? "postgresql://clawhub:clawhub@localhost:5432/clawhub";
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "..", "drizzle");

const pg = postgres(url, { max: 1 });
try {
  // Serialize against other replicas starting at the same time.
  await pg`select pg_advisory_lock(727274)`;
  await migrate(drizzle(pg), { migrationsFolder });
  console.log("[clawhub] migrations applied");
} finally {
  await pg.end();
}
