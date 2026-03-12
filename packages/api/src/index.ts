import { serve } from "@hono/node-server";
import { db } from "./models/db.js";
import { GitService } from "./services/git.js";
import { createApp } from "./app.js";

const port = parseInt(process.env.PORT ?? "3000", 10);
const gitBasePath = process.env.GIT_REPOS_BASE_PATH ?? "./data/repos";

const gitService = new GitService({ basePath: gitBasePath });
const app = createApp(db, gitService);

console.log(`ClawForge API starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
