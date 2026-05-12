import { db } from "./models/db.js";
import { GitClientPool } from "./services/git-client.js";
import { ReplicationTailer } from "./services/replication-tailer.js";
import { log } from "./services/logger.js";

const shardId = process.env.CLAWHUB_SHARD_ID;
if (!shardId) {
  console.error("CLAWHUB_SHARD_ID is required for the replication worker");
  process.exit(1);
}

const clients = new GitClientPool();
const tailer = new ReplicationTailer(db, clients, {
  shardId,
  intervalMs: Number(process.env.CLAWHUB_REPLICATION_INTERVAL_MS ?? 1_500),
  batchSize: Number(process.env.CLAWHUB_REPLICATION_BATCH ?? 256),
});

async function main() {
  await tailer.start();
  log("info", "replication_worker_started", { shardId, pid: process.pid });
}

function shutdown(signal: string) {
  log("info", "replication_worker_shutdown", { signal });
  tailer.stop().finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch(e => {
  log("error", "replication_worker_boot_failed", { err: (e as Error).message });
  process.exit(1);
});
