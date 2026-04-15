import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL ?? "postgresql://clawhub:clawhub@localhost:5432/clawhub";

export const pg = postgres(url, { max: 10 });
export const db = drizzle(pg, { schema });
export type DB = typeof db;
