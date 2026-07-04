// Routes for the server-authored-Change primitive (N5). Currently exposes the
// AGENTS.md auto-sync as an on-demand action; the underlying openServerChange is
// reusable for any future system-proposed edit.
import { Hono } from "hono";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import type { ChangeRefService } from "../services/change-refs.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForWrite } from "../services/repo-access.js";
import { syncAgentsMdChange } from "../services/server-change.js";

export function createServerChangeRoutes(db: DB, git: GitService, changeRefs: ChangeRefService, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // Open (or refresh) the AGENTS.md sync Change. Repo write — it proposes a
  // commit; a human still owns the merge. No-op + { changed:false } when current.
  app.post("/:ns/:repo/agents-md-sync", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const result = await syncAgentsMdChange({ db, git, changeRefs, events }, repo.id);
    return c.json(result);
  });

  return app;
}
