import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://clawforge:clawforge@localhost:5432/clawforge";

const client = postgres(connectionString);
export const db = drizzle(client, { schema });

export type Database = typeof db;
