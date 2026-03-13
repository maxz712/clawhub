import { serve } from "@hono/node-server";
import { db } from "./models/db.js";
import { GitService } from "./services/git.js";
import { IntentEngine } from "./services/intent.js";
import { EventBus } from "./services/events.js";
import { ChangeService } from "./services/changes.js";
import { createApp } from "./app.js";

const port = parseInt(process.env.PORT ?? "3000", 10);
const gitBasePath = process.env.GIT_REPOS_BASE_PATH ?? "./data/repos";

const gitService = new GitService({ basePath: gitBasePath });
const intentEngine = new IntentEngine();
const eventBus = new EventBus();
const changeService = new ChangeService(db, gitService, intentEngine, eventBus);

const app = createApp(db, gitService, changeService, eventBus);

console.log(`ClawForge API starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
