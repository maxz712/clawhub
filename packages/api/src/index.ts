import { serve } from "@hono/node-server";
import { db } from "./models/db.js";
import { GitService } from "./services/git.js";
import { EventBus } from "./services/events.js";
import { buildApp } from "./app.js";
import { isSecretsKeyConfigured } from "./services/secrets.js";

const port = Number(process.env.PORT ?? 3000);
const reposPath = process.env.GIT_REPOS_BASE_PATH ?? "./data/repos";

if (!isSecretsKeyConfigured()) {
  console.warn("[clawhub] CLAWHUB_SECRETS_KEY not set — secrets API will reject writes.");
}

const git = new GitService(reposPath);
const events = new EventBus();
const app = await buildApp({ db, git, events });

serve({ fetch: app.fetch, port });
console.log(`[clawhub] api listening on :${port}`);
