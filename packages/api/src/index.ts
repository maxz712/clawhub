import { serve } from "@hono/node-server";
import { db } from "./models/db.js";
import { GitService } from "./services/git.js";
import { EventBus } from "./services/events.js";
import { ChangeService } from "./services/changes.js";
import { ChangeRefService } from "./services/change-refs.js";
import { createApp } from "./app.js";

const port = parseInt(process.env.PORT ?? "3000", 10);
const gitBasePath = process.env.GIT_REPOS_BASE_PATH ?? "./data/repos";

const gitService = new GitService({ basePath: gitBasePath });
const eventBus = new EventBus();
const changeRefService = new ChangeRefService(gitBasePath);
const changeService = new ChangeService(db, gitService, eventBus, changeRefService);

const app = createApp(db, gitService, changeService, eventBus, changeRefService);

console.log(`ClawForge API starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
