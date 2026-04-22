import { Hono } from "hono";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import { search, countStats } from "../services/search.js";

export function createSearchRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();

  app.get("/", async c => {
    const q = c.req.query("q") ?? "";
    const publicOnly = c.req.query("public") === "1";
    const limit = Number(c.req.query("limit") ?? 20);
    const out = await search(db, git, q, { publicOnly, limit });
    return c.json(out);
  });

  app.get("/stats", async c => {
    const s = await countStats(db);
    return c.json(s);
  });

  return app;
}
