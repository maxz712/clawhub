// Shared harness for DB-integration tests. The default CI suite runs with NO
// Postgres — most tests use a fake `{} as DB` or pure logic. Tests that need a
// real database import `testDb` + `hasTestDb` from here and wrap their suite in
// `describe.skipIf(!hasTestDb)`, so they RUN against a migrated Postgres when
// CLAWHUB_TEST_DATABASE_URL is set (local dev / a DB-provisioned CI) and SKIP
// otherwise. Mirrors the pattern in memory-db.test.ts.
//
//   CLAWHUB_TEST_DATABASE_URL=postgresql://clawhub:clawhub@localhost:5432/clawhub npx vitest run
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

export const TEST_DATABASE_URL = process.env.CLAWHUB_TEST_DATABASE_URL;
export const hasTestDb = !!TEST_DATABASE_URL;

// Lazily created only when a test DB is configured; null (never connected) otherwise.
const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;
export const testDb = (client ? drizzle(client, { schema }) : null) as unknown as DB;
