import { db } from "./models/db.js";
import { GitService } from "./services/git.js";
import { EventBus } from "./services/events.js";
import { ChangeRefService } from "./services/change-refs.js";
import { ChangeService } from "./services/changes.js";
import { PushWorker } from "./services/push-queue.js";
import { MergeWorker } from "./services/merge-queue.js";
import { runPostPushJob } from "./services/post-push-runner.js";
import { ShardMap } from "./services/shard-map.js";
import { GitClientPool } from "./services/git-client.js";
import { log } from "./services/logger.js";

const reposPath = process.env.GIT_REPOS_BASE_PATH ?? "./data/repos";
const git = new GitService(reposPath);
const events = new EventBus();
const changeRefs = new ChangeRefService(git);
const changes = new ChangeService(db, git, events);
// The MergeWorker drains server-side merges (incl. hands-off auto-merge) by
// calling changes.merge(). Without shard routing, merging a repo hosted on a
// remote git-service shard falls back to local git ops on a repo that isn't on
// this host and fails — so the standalone worker MUST be shard-aware too, exactly
// like the in-process worker in app.ts. (No-op on single-host/local deployments.)
changes.setShardRouting(new ShardMap(db), new GitClientPool());

const pushWorker = new PushWorker({ count: Number(process.env.CLAWHUB_PUSH_WORKER_BATCH ?? 16) });
pushWorker.setHandler(job => runPostPushJob({ db, git, changeRefs, events }, job));

const mergeWorker = new MergeWorker({ changes });

async function main() {
  await pushWorker.start();
  await mergeWorker.start();
  log("info", "worker_started", { pid: process.pid });
}

function shutdown(signal: string) {
  log("info", "worker_shutdown", { signal });
  Promise.allSettled([pushWorker.stop(), mergeWorker.stop()]).finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch(e => {
  log("error", "worker_boot_failed", { err: (e as Error).message });
  process.exit(1);
});
