import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/models/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://clawforge:clawforge@localhost:5432/clawforge",
  },
});
